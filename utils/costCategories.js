// ============================================
// FILE: src/utils/costCategories.js
// ============================================

const COST_CATEGORIES = {
    'Maintenance & Repairs': [
        'Plumbing Repair',
        'Electrical Work',
        'Painting',
        'Carpentry',
        'HVAC Service',
        'Roofing Repair',
        'General Repair',
        'Pest Control',
    ],
    'Legal & Professional': [
        'Legal Fees',
        'Accounting Services',
        'Consultation',
        'Audit Fees',
    ],
    'Taxes & Licenses': [
        'Property Tax',
        'Business License',
        'Regulatory Fees',
        'Permit Fees',
    ],
    'Utilities': [
        'Water Bill (Common Area)',
        'Electricity (Common Area)',
        'Internet/WiFi',
        'Security Services',
        'Garbage Collection',
    ],
    'Insurance': [
        'Property Insurance',
        'Liability Insurance',
        'Fire Insurance',
    ],
    'Management Fees': [
        'Agent Commission',
        'Administrative Fees',
        'Marketing Expenses',
    ],
    'Other': [
        'Miscellaneous',
        'Emergency Expense',
    ],
};

const getCategoriesArray = () => {
    return Object.keys(COST_CATEGORIES);
};

const getFeeNamesByCategory = (category) => {
    return COST_CATEGORIES[category] || [];
};

module.exports = {
    COST_CATEGORIES,
    getCategoriesArray,
    getFeeNamesByCategory,
};
