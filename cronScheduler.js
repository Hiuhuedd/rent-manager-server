const cron = require('node-cron');
const { resetMonthlyPaymentTracking } = require('./smsProcessor');
const reminderService = require('./services/reminderService');
const settingsService = require('./services/settingsService');
const smsQuotaService = require('./services/smsQuotaService');

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

    // Add SMS Quota Reset
    console.log('♻️ Starting monthly SMS quota reset...');
    try {
      const smsResult = await smsQuotaService.resetMonthlyQuotas();
      if (smsResult.success) {
        console.log(`✅ SMS quotas reset for ${smsResult.count} agencies.`);
      } else {
        console.error('❌ SMS quota reset failed:', smsResult.error);
      }
    } catch (smsError) {
      console.error('❌ SMS quota reset error:', smsError.message);
    }
  }, {
    scheduled: true,
    timezone: "Africa/Nairobi" // Kenya timezone
  });

  console.log('✅ Cron job initialized successfully');
};

/**
 * Initialize payment reminder cron job
 * Runs every minute to check if reminders should be sent
 */
const initializeReminderCronJob = () => {
  console.log('🔔 Initializing payment reminder cron job...');
  console.log('   Schedule: Every minute');

  cron.schedule('* * * * *', async () => {
    try {
      // Fetch reminder config
      const settings = await settingsService.getSettings();
      const reminderConfig = settings.reminderConfig || { dayOfMonth: 15, time: '14:10' };

      // Check if we should send reminders now
      if (reminderService.shouldSendReminders(reminderConfig)) {
        console.log('\n🔔 PAYMENT REMINDER TRIGGERED');
        console.log(`   Time: ${new Date().toISOString()}`);
        console.log(`   Config: Day ${reminderConfig.dayOfMonth} at ${reminderConfig.time}`);

        const result = await reminderService.sendPaymentReminders();

        if (result.success) {
          console.log(`✅ Reminders sent: ${result.sentCount} successful, ${result.failedCount || 0} failed`);
        } else {
          console.error('❌ Reminder sending failed:', result.error);
        }
      }
    } catch (error) {
      console.error('❌ Reminder cron error:', error);
    }
  }, {
    scheduled: true,
    timezone: "Africa/Nairobi"
  });

  console.log('✅ Reminder cron job initialized');
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

  // Manual reminder trigger endpoint
  app.post('/admin/send-reminders', async (req, res) => {
    console.log('\n🔧 MANUAL REMINDER TRIGGER');
    console.log(`   Time: ${new Date().toISOString()}`);
    console.log(`   IP: ${req.ip}`);

    try {
      const result = await reminderService.sendPaymentReminders();

      if (result.success) {
        console.log(`✅ Reminders sent: ${result.sentCount}`);
        res.json({
          success: true,
          message: 'Payment reminders sent successfully',
          sentCount: result.sentCount,
          failedCount: result.failedCount || 0,
          timestamp: new Date().toISOString()
        });
      } else {
        res.status(500).json({
          success: false,
          error: 'Failed to send reminders',
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
  console.log('✅ Manual reminder endpoint created: POST /admin/send-reminders');
};

module.exports = {
  initializeMonthlyCronJob,
  initializeReminderCronJob,
  createManualResetEndpoint
};