const express = require('express');
const Faq = require('../models/FAQ');

const router = express.Router();

// Get all FAQs
router.get('/', async (req, res) => {
  try {
    const { category, question, sort, order } = req.query;
    const filter = {};

    if (category) filter.category = category;
    if (question) filter.questions = { $regex: question, $options: 'i' };

    // Default sort by creation date (newest first)
    let sortOption = { createdAt: -1 };

    // Handle sorting by questions
    if (sort === 'questions') {
      sortOption = { questions: order === 'desc' ? -1 : 1 };
    }

    const faqs = await Faq.find(filter).sort(sortOption);
    res.json(faqs);
  } catch (err) {
    console.error('Error fetching FAQs:', err);
    res.status(500).json({ error: 'Failed to fetch FAQs' });
  }
});

// Add new FAQ
router.post('/', async (req, res) => {
  console.log('POST /api/faqs body:', req.body);
  try {
    const { category, questions, answers } = req.body;

    if (!category || !questions || !answers) {
      return res
        .status(400)
        .json({ error: 'Category, questions, and answers are required' });
    }

    const newFaq = new Faq({ category, questions, answers });
    await newFaq.save();

    console.log('New FAQ saved:', newFaq);
    res.status(201).json(newFaq);
  } catch (err) {
    console.error('Error saving FAQ:', err);
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Update FAQ
router.put('/:id', async (req, res) => {
  try {
    const updated = await Faq.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
    });
    if (!updated) {
      return res.status(404).json({ error: 'FAQ not found' });
    }
    res.json(updated);
  } catch (err) {
    console.error('Error updating FAQ:', err);
    res.status(400).json({ error: 'Failed to update FAQ' });
  }
});

// Delete FAQ
router.delete('/:id', async (req, res) => {
  try {
    const deleted = await Faq.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ error: 'FAQ not found' });
    }
    res.json({ message: 'FAQ deleted' });
  } catch (err) {
    console.error('Error deleting FAQ:', err);
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

module.exports = router;
