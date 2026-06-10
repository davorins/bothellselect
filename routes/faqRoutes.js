const express = require('express');
const Faq = require('../models/Faq');

const router = express.Router();

// Get all FAQs
router.get('/', async (req, res) => {
  try {
    const { category, question, sort, order } = req.query;
    const filter = {};

    if (category) {
      filter.category = category;
    }

    if (question) {
      // Search in questions array
      filter.questions = { $regex: question, $options: 'i' };
    }

    let sortOption = { createdAt: -1 };
    if (sort === 'questions') {
      sortOption = { questions: order === 'desc' ? -1 : 1 };
    }

    const faqs = await Faq.find(filter).sort(sortOption);

    const formattedFaqs = faqs.map((faq) => ({
      _id: faq._id,
      category: faq.category,
      questions: faq.questions,
      answers: faq.answers,
      createdAt: faq.createdAt,
      __v: faq.__v,
    }));

    console.log(`Found ${formattedFaqs.length} FAQs`);
    res.json(formattedFaqs);
  } catch (err) {
    console.error('Error fetching FAQs:', err);
    res.status(500).json({
      error: 'Failed to fetch FAQs',
      details: err.message,
    });
  }
});

// Add new FAQ
router.post('/', async (req, res) => {
  try {
    const { category, questions, answers } = req.body;

    if (!category || !questions || !answers) {
      return res
        .status(400)
        .json({ error: 'Category, questions, and answers are required' });
    }

    const newFaq = new Faq({ category, questions, answers });
    await newFaq.save();
    res.status(201).json(newFaq);
  } catch (err) {
    console.error('Error saving FAQ:', err);
    res.status(400).json({ error: 'Invalid data' });
  }
});

// Update FAQ
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { category, questions, answers } = req.body;

    const updated = await Faq.findOneAndUpdate(
      { _id: id },
      { category, questions, answers },
      { new: true, runValidators: true },
    );

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
    const { id } = req.params;
    console.log('Deleting FAQ with ID:', id);

    const deleted = await Faq.findOneAndDelete({ _id: id });

    if (!deleted) {
      return res.status(404).json({ error: 'FAQ not found' });
    }

    res.json({ message: 'FAQ deleted', id });
  } catch (err) {
    console.error('Error deleting FAQ:', err);
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

module.exports = router;
