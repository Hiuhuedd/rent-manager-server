// ============================================
// MONTHLY RESET CRON JOB & SCHEDULER
// ============================================

const cron = require('node-cron');
const { resetMonthlyPaymentTracking } = require('./smsProcessor');

/**
 * Initialize cron job to reset monthly payments on 1st of every month at 00:01
 */
const initializeMonthlyCronJob = () => {
  // Schedule: Run at 00:01 on the 1st day of every month
  // Format: minute hour day-of-month month day-of-week
  const cronSchedule = '1 0 1 * *';
  
  console.log('📅 Initializing monthly reset cron job...');
  console.log(`   Schedule: ${cronSchedule} (00:01 on 1st of every month)`);
  
  cron.schedule(cronSchedule, async () => {
    console.log('\n🔔 MONTHLY RESET TRIGGERED');
    console.log(`   Time: ${new Date().toISOString()}`);
    
    try {
      const result = await resetMonthlyPaymentTracking();
      
      if (result.success) {
        console.log(`✅ Monthly reset completed successfully`);
        console.log(`   Tenants reset: ${result.resetCount}`);
      } else {
        console.error('❌ Monthly reset failed:', result.error);
      }
    } catch (error) {
      console.error('❌ Unexpected error during monthly reset:', error);
    }
  }, {
    scheduled: true,
    timezone: "Africa/Nairobi" // Kenya timezone
  });
  
  console.log('✅ Cron job initialized successfully');
};

/**
 * Manual trigger endpoint (for testing or manual resets)
 */
const createManualResetEndpoint = (app) => {
  app.post('/admin/reset-monthly-payments', async (req, res) => {
    console.log('\n🔧 MANUAL MONTHLY RESET TRIGGERED');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log(`   IP: ${req.ip}`);
    
    try {
      const result = await resetMonthlyPaymentTracking();
      
      if (result.success) {
        console.log(`✅ Manual reset completed: ${result.resetCount} tenants`);
        res.json({
          success: true,
          message: 'Monthly payment tracking reset successfully',
          tenantsReset: result.resetCount,
          timestamp: new Date().toISOString()
        });
      } else {
        console.error('❌ Manual reset failed:', result.error);
        res.status(500).json({
          success: false,
          error: 'Reset failed',
          details: result.error
        });
      }
    } catch (error) {
      console.error('❌ Unexpected error:', error);
      res.status(500).json({
        success: false,
        error: 'Internal server error',
        details: error.message
      });
    }
  });
  
  console.log('✅ Manual reset endpoint created: POST /admin/reset-monthly-payments');
};

module.exports = {
  initializeMonthlyCronJob,
  createManualResetEndpoint
};