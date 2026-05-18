const userService = require('../services/userService');
const statsService = require('../services/statsService');
const paymentService = require('../services/paymentService');
const { createSuccessResponse, createErrorResponse } = require('../utils/responseHelper');

class AdminController {
  async getSubagents(req, res) {
    try {
      const { agencyId } = req.user;
      const subagents = await userService.getSubagents(agencyId);
      res.json(createSuccessResponse(subagents));
    } catch (error) {
      res.status(500).json(createErrorResponse('Failed to fetch subagents', error.message));
    }
  }

  async createSubagent(req, res) {
    try {
      const { agencyId } = req.user;
      const subagentData = { ...req.body, agencyId };
      const result = await userService.createSubagent(subagentData);
      res.json(createSuccessResponse(result, 'Subagent created successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async toggleStatus(req, res) {
    try {
      const { subagentUid, status } = req.body;
      const result = await userService.toggleSubagentStatus(subagentUid, status);
      res.json(createSuccessResponse(result, `Subagent status updated to ${status} successfully`));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async updateSubagent(req, res) {
    try {
      const { subagentUid, ...updates } = req.body;
      const result = await userService.updateUserProfile(subagentUid, updates);
      res.json(createSuccessResponse(result, 'Subagent updated successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async deleteSubagent(req, res) {
    try {
      const { subagentUid } = req.params;
      const result = await userService.deleteSubagent(subagentUid);
      res.json(createSuccessResponse(result, 'Subagent deleted successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async assignProperty(req, res) {
    try {
      const { subagentUid, propertyId } = req.body;
      const result = await userService.assignProperty(subagentUid, propertyId);
      res.json(createSuccessResponse(result, 'Property assigned successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async unassignProperty(req, res) {
    try {
      const { subagentUid, propertyId } = req.body;
      const result = await userService.unassignProperty(subagentUid, propertyId);
      res.json(createSuccessResponse(result, 'Property unassigned successfully'));
    } catch (error) {
      res.status(400).json(createErrorResponse(error.message));
    }
  }

  async getStaffPerformance(req, res) {
    try {
      const { agencyId } = req.user;
      const { month } = req.query;
      const subagents = await userService.getSubagents(agencyId);
      
      const performance = await Promise.all(subagents.map(async (agent) => {
        const stats = await statsService.getStats(agencyId, agent.assignedProperties || [], month);
        const report = await paymentService.getMonthlyReport(agencyId, month, agent.assignedProperties || []);
        
        const expected = report?.summary?.totalExpected !== undefined ? report.summary.totalExpected : stats.revenue;
        const collected = report?.summary?.totalReceived || 0;
        const outstanding = report?.summary?.totalRemaining !== undefined ? report.summary.totalRemaining : Math.max(0, expected - collected);
        
        let efficiency = 0;
        if (expected > 0) {
          efficiency = (collected / expected) * 100;
        } else if (collected > 0) {
          efficiency = 100;
        } else {
          efficiency = 100; // If expected is 0 and collected is 0, they are 100% efficient
        }

        return {
          uid: agent.uid,
          name: agent.name,
          email: agent.email,
          propertyCount: agent.assignedProperties?.length || 0,
          expected,
          collected,
          outstanding,
          expenses: stats.expenses,
          performance: efficiency
        };
      }));

      res.json(createSuccessResponse(performance));
    } catch (error) {
      console.error('[ADMIN] Staff performance error:', error);
      res.status(500).json(createErrorResponse('Failed to fetch staff performance', error.message));
    }
  }
}

module.exports = new AdminController();
