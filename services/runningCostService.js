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
    async addCost({ propertyId, agencyId, category, feeName, amount, description, date, createdBy, unitId, unitName, unitCode }) {
        const costData = {
            propertyId,
            agencyId,
            category,
            feeName,
            amount: parseFloat(amount) || 0,
            description: description || '',
            date: date ? new Date(date) : new Date(),
            createdBy: createdBy || 'system',
            createdAt: serverTimestamp(),
            unitId: unitId || null,
            unitName: unitName || null,
            unitCode: unitCode || null,
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
    async getCostsByProperty(propertyId, agencyId) {
        const q = query(
            collection(db, 'runningCosts'),
            where('propertyId', '==', propertyId),
            where('agencyId', '==', agencyId)
        );

        const snapshot = await getDocs(q);
        const costs = snapshot.docs.map(doc => {
            const data = doc.data();
            let dateObj = null;
            if (data.date) {
                try {
                    dateObj = data.date.toDate ? data.date.toDate() : new Date(data.date);
                    if (isNaN(dateObj.getTime())) dateObj = null;
                } catch (e) {
                    dateObj = null;
                }
            }
            return {
                id: doc.id,
                ...data,
                date: dateObj,
                createdAt: data.createdAt?.toDate?.() || null,
            };
        });

        // Sort in memory to avoid composite index requirement
        return costs.sort((a, b) => (b.date || 0) - (a.date || 0));
    }

    /**
     * Get costs for a property within a specific month
     */
    async getCostsByPropertyAndMonth(propertyId, month, agencyId) {
        // month format: YYYY-MM
        const [year, monthNum] = month.split('-').map(Number);
        const startDate = new Date(year, monthNum - 1, 1);
        const endDate = new Date(year, monthNum, 0, 23, 59, 59);

        const allCosts = await this.getCostsByProperty(propertyId, agencyId);

        return allCosts.filter(cost => {
            const costDate = cost.date;
            if (!costDate) return false;
            const inRange = costDate >= startDate && costDate <= endDate;
            return inRange;
        });
    }

    /**
     * Delete a running cost
     */
    async deleteCost(costId, agencyId) {
        const costRef = doc(db, 'runningCosts', costId);
        const costSnap = await getDoc(costRef);

        if (!costSnap.exists()) {
            throw new Error('Cost record not found');
        }
        
        // Security Check
        if (agencyId && costSnap.data().agencyId !== agencyId) {
            throw new Error('Unauthorized: Cost record belongs to another agency');
        }

        await deleteDoc(costRef);
        console.log(`[SUCCESS] Running cost deleted: ${costId}`);
        return { success: true };
    }

    /**
     * Update an existing running cost
     */
    async updateCost(costId, updates) {
        const { db } = require('../config/firebase');
        const { updateDoc } = require('firebase/firestore');

        const costRef = doc(db, 'runningCosts', costId);

        // Sanitize updates
        const filteredUpdates = {};
        if (updates.category) filteredUpdates.category = updates.category;
        if (updates.feeName) filteredUpdates.feeName = updates.feeName;
        if (updates.amount) filteredUpdates.amount = parseFloat(updates.amount) || 0;
        if (updates.description !== undefined) filteredUpdates.description = updates.description;
        if (updates.date) filteredUpdates.date = new Date(updates.date);

        filteredUpdates.updatedAt = serverTimestamp();

        await updateDoc(costRef, filteredUpdates);
        console.log(`[SUCCESS] Running cost updated: ${costId}`);

        return { id: costId, ...filteredUpdates };
    }

    /**
     * Get all costs (global list)
     */
    async getAllCosts(agencyId, assignedProperties = []) {
        let q;
        if (assignedProperties.length > 0) {
            q = query(
                collection(db, 'runningCosts'),
                where('agencyId', '==', agencyId),
                where('propertyId', 'in', assignedProperties)
            );
        } else {
            q = query(
                collection(db, 'runningCosts'),
                where('agencyId', '==', agencyId)
            );
        }

        const snapshot = await getDocs(q);
        const costs = snapshot.docs.map(doc => {
            const data = doc.data();
            let dateObj = null;
            if (data.date) {
                try {
                    dateObj = data.date.toDate ? data.date.toDate() : new Date(data.date);
                    if (isNaN(dateObj.getTime())) dateObj = null;
                } catch (e) {
                    dateObj = null;
                }
            }
            return {
                id: doc.id,
                ...data,
                date: dateObj,
                createdAt: data.createdAt?.toDate?.() || null,
            };
        });

        return costs.sort((a, b) => (b.date || 0) - (a.date || 0));
    }

    /**
     * Get total costs for a property in a month (aggregated)
     */
    async getTotalCostsByMonth(propertyId, month, agencyId) {
        const costs = propertyId === 'all' 
            ? await this.getCostsByMonth(month, agencyId)
            : await this.getCostsByPropertyAndMonth(propertyId, month, agencyId);
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
            items: costs,
            itemCount: costs.length,
        };
    }

    /**
     * Get costs for all properties within a specific month
     */
    async getCostsByMonth(month, agencyId, assignedProperties = []) {
        const [year, monthNum] = month.split('-').map(Number);
        const startDate = new Date(year, monthNum - 1, 1);
        const endDate = new Date(year, monthNum, 0, 23, 59, 59);

        console.log(`[DEBUG] Global costs for ${month}`);
        console.log(`[DEBUG] Range: ${startDate.toISOString()} to ${endDate.toISOString()}`);

        const allCosts = await this.getAllCosts(agencyId, assignedProperties);
        console.log(`[DEBUG] Total costs in DB: ${allCosts.length}`);

        const filtered = allCosts.filter(cost => {
            const costDate = cost.date;
            if (!costDate) return false;
            return costDate >= startDate && costDate <= endDate;
        });

        console.log(`[DEBUG] Filtered costs for ${month}: ${filtered.length}`);
        return filtered;
    }
}

module.exports = new RunningCostService();
