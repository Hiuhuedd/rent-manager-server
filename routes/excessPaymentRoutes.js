// ============================================
// FILE: routes/excessPaymentRoutes.js
// ============================================
const express = require('express');
const router = express.Router();
const { db } = require('../config/firebase');
const { doc, getDoc, updateDoc, collection, query, where, getDocs, setDoc } = require('firebase/firestore');
const { PAYMENT_STATUS } = require('../config/constants');

/**
 * Get tenant's total excess balance
 * GET /api/excess/:tenantId
 */
router.get('/:tenantId', async (req, res) => {
    try {
        const { tenantId } = req.params;

        // Get all financial records for this tenant
        const financialQuery = query(
            collection(db, 'financial_records'),
            where('tenantId', '==', tenantId)
        );
        const financialSnapshot = await getDocs(financialQuery);

        // Group by month and calculate excess
        const excessByMonth = {};
        financialSnapshot.docs.forEach(doc => {
            const record = doc.data();
            const month = record.paymentMonth;
            const excess = record.allocation?.excess || 0;

            if (!excessByMonth[month]) {
                excessByMonth[month] = {
                    month,
                    totalExcess: 0,
                    payments: []
                };
            }

            if (excess > 0) {
                excessByMonth[month].totalExcess += excess;
                excessByMonth[month].payments.push({
                    transactionId: record.transactionId,
                    amount: record.amount,
                    excess,
                    date: record.paymentDate
                });
            }
        });

        const totalExcess = Object.values(excessByMonth).reduce(
            (sum, m) => sum + m.totalExcess,
            0
        );

        res.json({
            success: true,
            data: {
                tenantId,
                totalExcess,
                byMonth: excessByMonth
            }
        });
    } catch (error) {
        console.error('Error fetching excess balance:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Apply excess to a specific month
 * POST /api/excess/:tenantId/apply
 * Body: { sourceMonth, targetMonth, amount }
 */
router.post('/:tenantId/apply', async (req, res) => {
    try {
        const { tenantId } = req.params;
        const { sourceMonth, targetMonth, amount } = req.body;

        if (!sourceMonth || !targetMonth || !amount) {
            return res.status(400).json({
                success: false,
                error: 'sourceMonth, targetMonth, and amount are required'
            });
        }

        if (amount <= 0) {
            return res.status(400).json({
                success: false,
                error: 'Amount must be greater than 0'
            });
        }

        // Get tenant data
        const tenantRef = doc(db, 'tenants', tenantId);
        const tenantSnap = await getDoc(tenantRef);

        if (!tenantSnap.exists()) {
            return res.status(404).json({
                success: false,
                error: 'Tenant not found'
            });
        }

        const tenant = tenantSnap.data();

        // Verify tenant has enough excess in source month
        const sourceQuery = query(
            collection(db, 'financial_records'),
            where('tenantId', '==', tenantId),
            where('paymentMonth', '==', sourceMonth)
        );
        const sourceSnapshot = await getDocs(sourceQuery);

        const totalSourceExcess = sourceSnapshot.docs.reduce(
            (sum, doc) => sum + (doc.data().allocation?.excess || 0),
            0
        );

        if (totalSourceExcess < amount) {
            return res.status(400).json({
                success: false,
                error: `Insufficient excess in ${sourceMonth}. Available: ${totalSourceExcess}, Requested: ${amount}`
            });
        }

        // Get unit details for target month calculation
        const unitsQuery = query(
            collection(db, 'units'),
            where('unitId', '==', tenant.unitCode)
        );
        const unitsSnapshot = await getDocs(unitsQuery);

        if (unitsSnapshot.empty) {
            return res.status(404).json({
                success: false,
                error: 'Unit not found'
            });
        }

        const unit = unitsSnapshot.docs[0].data();

        // Calculate expected amounts for target month
        const rent = parseFloat(unit.rentAmount) || 0;
        const garbage = parseFloat(unit.utilityFees?.garbageFee) || 0;
        const water = parseFloat(unit.utilityFees?.waterBill) || 0;
        const deposit = parseFloat(unit.depositAmount) || 0;

        // Check if deposit should be included in target month
        const [targetYear, targetMonthNum] = targetMonth.split('-').map(Number);
        const moveInDate = tenant.moveInDate ? new Date(tenant.moveInDate) : null;
        const moveInYear = moveInDate?.getFullYear();
        const moveInMonth = moveInDate ? moveInDate.getMonth() + 1 : null;
        const isFirstMonth = moveInYear === targetYear && moveInMonth === targetMonthNum;
        const depositPending = tenant.rentDeposit?.status === 'pending';
        const includeDeposit = isFirstMonth && depositPending;

        const expectedTotal = rent + garbage + water + (includeDeposit ? deposit : 0);

        // Get existing payments for target month
        const targetQuery = query(
            collection(db, 'financial_records'),
            where('tenantId', '==', tenantId),
            where('paymentMonth', '==', targetMonth)
        );
        const targetSnapshot = await getDocs(targetQuery);

        let depositPaid = 0;
        let rentPaid = 0;
        let utilitiesPaid = 0;

        targetSnapshot.docs.forEach(doc => {
            const payment = doc.data();
            depositPaid += payment.allocation?.deposit || 0;
            rentPaid += payment.allocation?.rent || 0;
            utilitiesPaid += payment.allocation?.utilities || 0;
        });

        // Allocate the excess amount
        let remainingAmount = amount;
        let allocatedToDeposit = 0;
        let allocatedToRent = 0;
        let allocatedToUtilities = 0;

        // Priority 1: Deposit
        const depositRemaining = Math.max(0, (includeDeposit ? deposit : 0) - depositPaid);
        if (depositRemaining > 0 && remainingAmount > 0) {
            allocatedToDeposit = Math.min(remainingAmount, depositRemaining);
            remainingAmount -= allocatedToDeposit;
        }

        // Priority 2: Rent
        const rentRemaining = Math.max(0, rent - rentPaid);
        if (rentRemaining > 0 && remainingAmount > 0) {
            allocatedToRent = Math.min(remainingAmount, rentRemaining);
            remainingAmount -= allocatedToRent;
        }

        // Priority 3: Utilities
        const utilitiesRemaining = Math.max(0, (garbage + water) - utilitiesPaid);
        if (utilitiesRemaining > 0 && remainingAmount > 0) {
            allocatedToUtilities = Math.min(remainingAmount, utilitiesRemaining);
            remainingAmount -= allocatedToUtilities;
        }

        // Calculate new totals
        const newDepositPaid = depositPaid + allocatedToDeposit;
        const newRentPaid = rentPaid + allocatedToRent;
        const newUtilitiesPaid = utilitiesPaid + allocatedToUtilities;
        const newTotalPaid = newDepositPaid + newRentPaid + newUtilitiesPaid;

        const newRemaining = Math.max(0, expectedTotal - newTotalPaid);

        // Determine new status
        let newStatus = PAYMENT_STATUS.UNPAID;
        if (newTotalPaid >= expectedTotal) {
            newStatus = PAYMENT_STATUS.PAID;
        } else if (newTotalPaid > 0) {
            newStatus = PAYMENT_STATUS.PARTIAL;
        }

        // Create financial record for the applied excess
        const timestamp = new Date().toISOString();
        const financialRecord = {
            transactionId: `EXCESS_${sourceMonth}_${Date.now()}`,
            tenantId: tenantId,  // Use tenantId from params, not tenant.id
            tenantName: tenant.name,
            tenantPhone: tenant.phone,
            unitId: unitsSnapshot.docs[0].id,
            unitCode: tenant.unitCode,
            propertyId: tenant.propertyId,
            propertyName: tenant.propertyDetails?.propertyName || '',
            amount,
            paymentDate: timestamp,
            paymentMonth: targetMonth,
            timestamp,
            senderName: 'Excess Application',
            senderPhone: tenant.phone,
            accountNumber: tenant.phone,
            matchStrategy: 'excess_application',
            allocation: {
                deposit: allocatedToDeposit,
                rent: allocatedToRent,
                utilities: allocatedToUtilities,
                excess: remainingAmount,
                fromExcess: amount
            },
            monthlyTracking: {
                expectedTotal,
                totalPaid: newTotalPaid,
                remainingAmount: newRemaining,
                status: newStatus,
                breakdown: {
                    deposit: {
                        required: includeDeposit ? deposit : 0,
                        paid: newDepositPaid,
                        remaining: Math.max(0, (includeDeposit ? deposit : 0) - newDepositPaid)
                    },
                    rent: {
                        required: rent,
                        paid: newRentPaid,
                        remaining: Math.max(0, rent - newRentPaid)
                    },
                    utilities: {
                        required: garbage + water,
                        paid: newUtilitiesPaid,
                        remaining: Math.max(0, (garbage + water) - newUtilitiesPaid)
                    }
                }
            },
            isExcessApplication: true,
            sourceMonth,
            processed: true,
            createdAt: timestamp
        };

        // Save the financial record
        const financialRecordRef = doc(db, 'financial_records', timestamp);
        await setDoc(financialRecordRef, financialRecord);

        console.log(`✅ Applied ${amount} excess from ${sourceMonth} to ${targetMonth} for tenant ${tenant.name}`);

        res.json({
            success: true,
            data: {
                transactionId: financialRecord.transactionId,
                sourceMonth,
                targetMonth,
                amountApplied: amount,
                allocation: {
                    deposit: allocatedToDeposit,
                    rent: allocatedToRent,
                    utilities: allocatedToUtilities,
                    excess: remainingAmount
                },
                newStatus,
                newTotalPaid,
                newRemaining
            }
        });
    } catch (error) {
        console.error('Error applying excess:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
