// ============================================
// FILE: src/utils/dateHelper.js
// ============================================

/**
 * Get current month in YYYY-MM format
 * @returns {string} Current month (e.g., "2025-01")
 */
function getCurrentMonth() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

/**
 * Get month start date
 * @param {string} month - Month in YYYY-MM format
 * @returns {Date} Start of the month
 */
function getMonthStart(month) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(year, monthNum - 1, 1, 0, 0, 0, 0);
}

/**
 * Get month end date
 * @param {string} month - Month in YYYY-MM format
 * @returns {Date} End of the month
 */
function getMonthEnd(month) {
  const [year, monthNum] = month.split('-').map(Number);
  return new Date(year, monthNum, 0, 23, 59, 59, 999);
}

/**
 * Check if a tenant moved in this month
 * @param {string} moveInDate - ISO date string
 * @param {string} month - Optional month in YYYY-MM format (defaults to current)
 * @returns {boolean}
 */
function isMovedInThisMonth(moveInDate, month = null) {
  if (!moveInDate) return false;

  const targetMonth = month || getCurrentMonth();
  const [targetYear, targetMonthNum] = targetMonth.split('-').map(Number);
  
  const moveIn = new Date(moveInDate);
  const moveInYear = moveIn.getFullYear();
  const moveInMonth = moveIn.getMonth() + 1;

  return moveInYear === targetYear && moveInMonth === targetMonthNum;
}

/**
 * Check if a record was active during a specific month
 * @param {Object} record - Record with createdAt, deletedAt, moveInDate, moveOutDate
 * @param {string} month - Month in YYYY-MM format
 * @returns {boolean}
 */
function isRecordActiveInMonth(record, month) {
  const monthStart = getMonthStart(month);
  const monthEnd = getMonthEnd(month);

  // Check creation date
  const createdAt = record.createdAt ? new Date(record.createdAt) : null;
  if (createdAt && createdAt > monthEnd) {
    return false; // Created after target month
  }

  // Check deletion/deactivation date
  const deletedAt = record.deletedAt || record.deactivatedAt || record.vacatedDate;
  if (deletedAt) {
    const deletionDate = new Date(deletedAt);
    if (deletionDate < monthStart) {
      return false; // Deleted before target month
    }
  }

  // For tenants, check move-in and move-out dates
  if (record.moveInDate) {
    const moveInDate = new Date(record.moveInDate);
    if (moveInDate > monthEnd) {
      return false; // Moved in after target month
    }
  }

  if (record.moveOutDate) {
    const moveOutDate = new Date(record.moveOutDate);
    if (moveOutDate < monthStart) {
      return false; // Moved out before target month
    }
  }

  return true;
}

/**
 * Format month for display
 * @param {string} month - Month in YYYY-MM format
 * @returns {string} Formatted month (e.g., "January 2025")
 */
function formatMonth(month) {
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

/**
 * Get previous month
 * @param {string} month - Month in YYYY-MM format
 * @returns {string} Previous month in YYYY-MM format
 */
function getPreviousMonth(month) {
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() - 1);
  
  const newYear = date.getFullYear();
  const newMonth = String(date.getMonth() + 1).padStart(2, '0');
  return `${newYear}-${newMonth}`;
}

/**
 * Get next month
 * @param {string} month - Month in YYYY-MM format
 * @returns {string} Next month in YYYY-MM format
 */
function getNextMonth(month) {
  const [year, monthNum] = month.split('-').map(Number);
  const date = new Date(year, monthNum - 1, 1);
  date.setMonth(date.getMonth() + 1);
  
  const newYear = date.getFullYear();
  const newMonth = String(date.getMonth() + 1).padStart(2, '0');
  return `${newYear}-${newMonth}`;
}

/**
 * Get list of months between two dates
 * @param {string} startMonth - Start month in YYYY-MM format
 * @param {string} endMonth - End month in YYYY-MM format
 * @returns {string[]} Array of months in YYYY-MM format
 */
function getMonthsBetween(startMonth, endMonth) {
  const months = [];
  let current = startMonth;
  
  while (current <= endMonth) {
    months.push(current);
    current = getNextMonth(current);
  }
  
  return months;
}

/**
 * Check if month is in the future
 * @param {string} month - Month in YYYY-MM format
 * @returns {boolean}
 */
function isFutureMonth(month) {
  const currentMonth = getCurrentMonth();
  return month > currentMonth;
}

/**
 * Validate month format
 * @param {string} month - Month string to validate
 * @returns {boolean}
 */
function isValidMonth(month) {
  if (!month) return false;
  
  const regex = /^\d{4}-\d{2}$/;
  if (!regex.test(month)) return false;
  
  const [year, monthNum] = month.split('-').map(Number);
  return year >= 2000 && year <= 2100 && monthNum >= 1 && monthNum <= 12;
}

/**
 * Get financial year months
 * @param {number} year - Financial year
 * @param {number} startMonth - Starting month of financial year (1-12)
 * @returns {string[]} Array of months in YYYY-MM format
 */
function getFinancialYearMonths(year, startMonth = 1) {
  const months = [];
  
  for (let i = 0; i < 12; i++) {
    const monthNum = ((startMonth - 1 + i) % 12) + 1;
    const yearOffset = Math.floor((startMonth - 1 + i) / 12);
    const fullYear = year + yearOffset;
    
    months.push(`${fullYear}-${String(monthNum).padStart(2, '0')}`);
  }
  
  return months;
}

module.exports = {
  getCurrentMonth,
  getMonthStart,
  getMonthEnd,
  isMovedInThisMonth,
  isRecordActiveInMonth,
  formatMonth,
  getPreviousMonth,
  getNextMonth,
  getMonthsBetween,
  isFutureMonth,
  isValidMonth,
  getFinancialYearMonths,
};


// ============================================
// USAGE EXAMPLES
// ============================================

/*
Example Usage:

1. Check if tenant was active in January 2025:
   const tenant = { moveInDate: '2024-12-15', moveOutDate: null };
   const isActive = isRecordActiveInMonth(tenant, '2025-01'); // true

2. Check if tenant moved in this month:
   const movedIn = isMovedInThisMonth('2025-01-15', '2025-01'); // true

3. Get month range:
   const months = getMonthsBetween('2024-10', '2025-01'); 
   // ['2024-10', '2024-11', '2024-12', '2025-01']

4. Validate month format:
   const valid = isValidMonth('2025-01'); // true
   const invalid = isValidMonth('2025-13'); // false
*/