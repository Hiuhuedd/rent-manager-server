// ============================================
// FILE: src/services/runningCostService.js
// ============================================
const { db } = require('../config/firebase');
const {
    collection,
    addDoc,
    getDocs,
    getDoc,
    doc,
    query,
    where,
    deleteDoc,
    serverTimestamp,
    orderBy,
} = require('firebase/firestore');

class RunningCostService {
    /**
     * Add a new running cost
     */
    async addCost({ propertyId, category, feeName, amount, description, date, createdBy }) {
        const costData = {
            propertyId,
            category,
            feeName,
            amount: parseFloat(amount) || 0,
            description: description || '',
            date: date || new Date(),
            createdBy: createdBy || 'system',
            createdAt: serverTimestamp(),
        };

        const docRef = await addDoc(collection(db, 'runningCosts'), costData);

        console.log(`[SUCCESS] Running cost added: ${feeName} | ${amount} | ID: ${docRef.id}`);

        return {
            id: docRef.id,
            ...costData,
        };
    }

    /**
     * Get all costs for a specific property
     */
    async getCostsByProperty(propertyId) {
        const q = query(
            collection(db, 'runningCosts'),
            where('propertyId', '==', propertyId),
            orderBy('date', 'desc')
        );

        const snapshot = await getDocs(q);
        return snapshot.docs.map(doc => ({
            id: doc.id,
            ...doc.data(),
            date: doc.data().date?.toDate?.() || null,
            createdAt: doc.data().createdAt?.toDate?.() || null,
        }));
    }

    /**
     * Get costs for a property within a specific month
     */
    async getCostsByPropertyAndMonth(propertyId, month) {
        // month format: YYYY-MM
        const [year, monthNum] = month.split('-').map(Number);
        const startDate = new Date(year, monthNum - 1, 1);
        const endDate = new Date(year, monthNum, 0, 23, 59, 59);

        const allCosts = await this.getCostsByProperty(propertyId);

        return allCosts.filter(cost => {
            const costDate = cost.date;
            return costDate >= startDate && costDate <= endDate;
        });
    }

    /**
     * Delete a running cost
     */
    async deleteCost(costId) {
        const costRef = doc(db, 'runningCosts', costId);
        const costSnap = await getDoc(costRef);

        if (!costSnap.exists()) {
            throw new Error('Cost record not found');
        }

        await deleteDoc(costRef);
        console.log(`[SUCCESS] Running cost deleted: ${costId}`);
        return { success: true };
    }

    /**
     * Get total costs for a property in a month (aggregated)
     */
    async getTotalCostsByMonth(propertyId, month) {
        const costs = await this.getCostsByPropertyAndMonth(propertyId, month);
        const totalAmount = costs.reduce((sum, cost) => sum + cost.amount, 0);

        // Group by category
        const byCategory = costs.reduce((acc, cost) => {
            if (!acc[cost.category]) {
                acc[cost.category] = 0;
            }
            acc[cost.category] += cost.amount;
            return acc;
        }, {});

        return {
            totalAmount,
            byCategory,
            itemCount: costs.length,
        };
    }
}

module.exports = new RunningCostService();
