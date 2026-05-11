// controllers/registrationController.js
const SeasonEvent = require('../models/SeasonEvent');
const RegistrationFormConfig = require('../models/RegistrationFormConfig');

// Season Events
exports.getSeasonEvents = async (req, res) => {
  try {
    const events = await SeasonEvent.find().sort({ year: -1, season: 1 });
    res.json(events);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch season events' });
  }
};

exports.createSeasonEvent = async (req, res) => {
  try {
    const event = new SeasonEvent(req.body);
    await event.save();
    res.status(201).json(event);
  } catch (error) {
    res.status(400).json({ error: 'Failed to create season event' });
  }
};

exports.updateSeasonEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    const event = await SeasonEvent.findOneAndUpdate({ eventId }, req.body, {
      new: true,
    });
    res.json(event);
  } catch (error) {
    res.status(400).json({ error: 'Failed to update season event' });
  }
};

exports.deleteSeasonEvent = async (req, res) => {
  try {
    const { eventId } = req.params;
    await SeasonEvent.findOneAndDelete({ eventId });
    res.json({ message: 'Season event deleted successfully' });
  } catch (error) {
    res.status(400).json({ error: 'Failed to delete season event' });
  }
};

// Form Configurations
exports.updateFormConfig = async (req, res) => {
  try {
    const { eventId, season, year, config } = req.body;

    // Validate required fields
    if (!eventId) {
      return res.status(400).json({ error: 'eventId is required' });
    }

    // Get season event details
    const seasonEvent = await SeasonEvent.findOne({ eventId });
    if (!seasonEvent) {
      return res.status(404).json({ error: 'Season event not found' });
    }

    // Use season event data
    const seasonName = season || seasonEvent.season;
    const seasonYear = year || seasonEvent.year;

    // Prepare the update data
    const updateData = {
      eventId,
      season: seasonName,
      year: seasonYear,
      isActive: config.isActive,
      requiresPayment: config.requiresPayment,
      requiresQualification: config.requiresQualification,
      description: config.description || '',
      pricing: {
        basePrice: config.pricing?.basePrice || 0,
        packages: config.pricing?.packages || [],
      },
    };

    // Include trainingDetails if it exists in the config
    if (config.trainingDetails) {
      updateData.trainingDetails = config.trainingDetails;
      console.log(
        '📝 Saving trainingDetails:',
        JSON.stringify(config.trainingDetails, null, 2),
      );
    }

    // Update or create form config
    const formConfig = await RegistrationFormConfig.findOneAndUpdate(
      { eventId },
      updateData,
      { upsert: true, new: true, runValidators: true },
    );

    console.log('✅ Form config saved successfully:', {
      eventId: formConfig.eventId,
      hasTrainingDetails: !!formConfig.trainingDetails,
      trainingDetailsKeys: formConfig.trainingDetails
        ? Object.keys(formConfig.trainingDetails.toObject())
        : [],
    });

    res.json(formConfig);
  } catch (error) {
    console.error('Update form config error:', error);
    res.status(400).json({ error: 'Failed to update form configuration' });
  }
};

exports.getFormConfigs = async (req, res) => {
  try {
    const configs = await RegistrationFormConfig.find();
    console.log('📊 Found configs:', configs.length);

    const configMap = {};
    configs.forEach((config) => {
      const key = config.eventId || `${config.season}-${config.year}`;

      // Ensuring the pricing packages are properly formatted
      const configObj = config.toObject ? config.toObject() : config;

      if (!configObj.pricing) {
        configObj.pricing = { basePrice: 0, packages: [] };
      }
      if (!configObj.pricing.packages) {
        configObj.pricing.packages = [];
      }

      configObj.pricing.packages = configObj.pricing.packages.map((pkg) => ({
        id: pkg.id || pkg._id?.toString(),
        name: pkg.name || '',
        price: pkg.price || 0,
        description: pkg.description || '',
        ...pkg,
      }));

      // Ensure trainingDetails exists (even if empty)
      if (!configObj.trainingDetails) {
        configObj.trainingDetails = {
          startDate: '',
          endDate: '',
          duration: '',
          gender: '',
          days: [],
          location: { name: '', address: '', city: '', state: '', zipCode: '' },
          trainingSessions: [],
          notes: [],
          dropOffTime: '',
          pickUpTime: '',
          hasLimitedSpots: false,
          contactEmail: '',
          ageGroups: [],
          maxParticipants: null,
        };
      }

      configMap[key] = configObj;
    });

    console.log('🎯 Config keys sent:', Object.keys(configMap));
    res.json(configMap);
  } catch (error) {
    console.error('❌ Get form configs error:', error);
    res.status(500).json({ error: 'Failed to fetch form configurations' });
  }
};

// A function to get active season events with configs
exports.getActiveSeasonEvents = async (req, res) => {
  try {
    // Get all active season events
    const seasonEvents = await SeasonEvent.find({ registrationOpen: true });

    // Get form configs for these events
    const eventIds = seasonEvents.map((event) => event.eventId);
    const formConfigs = await RegistrationFormConfig.find({
      eventId: { $in: eventIds },
      isActive: true,
    });

    // Combine data
    const activeEvents = seasonEvents.map((event) => {
      const config = formConfigs.find((cfg) => cfg.eventId === event.eventId);
      return {
        ...event.toObject(),
        formConfig: config || null,
      };
    });

    res.json(activeEvents);
  } catch (error) {
    console.error('Get active season events error:', error);
    res.status(500).json({ error: 'Failed to fetch active season events' });
  }
};

exports.getFormConfig = async (req, res) => {
  try {
    const { season, year } = req.query;

    if (!season || !year) {
      return res.status(400).json({ error: 'Season and year are required' });
    }

    const formConfig = await RegistrationFormConfig.findOne({ season, year });

    if (!formConfig) {
      return res.status(404).json({ error: 'Form configuration not found' });
    }

    res.json(formConfig);
  } catch (error) {
    console.error('Get form config error:', error);
    res.status(500).json({ error: 'Failed to fetch form configuration' });
  }
};

exports.getActiveForms = async (req, res) => {
  try {
    const activeConfigs = await RegistrationFormConfig.find({
      isActive: true,
    });

    res.json(activeConfigs);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch active forms' });
  }
};
