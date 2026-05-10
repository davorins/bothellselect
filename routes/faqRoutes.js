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
  console.log('POST /api/faqs body:', req.body);
  try {
    const { category, questions, answers } = req.body;

    if (!category || !questions || !answers) {
      return res
        .status(400)
        .json({ error: 'Category, questions, and answers are required' });
    }

    // Generate a custom ID
    const count = await Faq.countDocuments();
    const newId = `bothellselect_faq_${String(count + 1).padStart(3, '0')}`;

    const newFaq = new Faq({
      _id: newId,
      category,
      questions,
      answers,
    });

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
    const { id } = req.params;
    console.log('Updating FAQ with ID:', id);
    console.log('Update data:', req.body);

    const updated = await Faq.findByIdAndUpdate(id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!updated) {
      return res.status(404).json({ error: 'FAQ not found' });
    }

    console.log('FAQ updated successfully:', updated);
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

    const deleted = await Faq.findByIdAndDelete(id);

    if (!deleted) {
      return res.status(404).json({ error: 'FAQ not found' });
    }

    console.log('FAQ deleted successfully:', deleted);
    res.json({ message: 'FAQ deleted', id });
  } catch (err) {
    console.error('Error deleting FAQ:', err);
    res.status(500).json({ error: 'Failed to delete FAQ' });
  }
});

module.exports = router;
