// src/services/template.service.ts
const EmailTemplate = require('../models/EmailTemplate');

export class TemplateService {
  // Get template by title
  static async getTemplateByTitle(title: string) {
    return EmailTemplate.findOne({ title }).lean();
  }

  // Get template by category
  static async getTemplatesByCategory(category: string) {
    return EmailTemplate.find({ category, status: true }).lean();
  }

  // Get all active templates
  static async getAllActiveTemplates() {
    return EmailTemplate.find({ status: true }).lean();
  }

  // Get template by ID
  static async getTemplateById(id: string) {
    return EmailTemplate.findById(id).lean();
  }
}
