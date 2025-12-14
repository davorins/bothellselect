// registrationController.js
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
    const { season, year, config } = req.body;

    // Validate required fields
    if (!season || !year) {
      return res.status(400).json({ error: 'Season and year are required' });
    }

    const formConfig = await RegistrationFormConfig.findOneAndUpdate(
      { season, year },
      config,
      { upsert: true, new: true, runValidators: true }
    );

    res.json(formConfig);
  } catch (error) {
    console.error('Update form config error:', error);
    res.status(400).json({ error: 'Failed to update form configuration' });
  }
};

exports.getFormConfigs = async (req, res) => {
  try {
    const configs = await RegistrationFormConfig.find();
    console.log(
      '📊 Raw configs from database:',
      JSON.stringify(configs, null, 2)
    );

    const configMap = {};

    configs.forEach((config) => {
      const key = `${config.season}-${config.year}`;
      console.log(`🔑 Creating key: ${key}`, {
        season: config.season,
        year: config.year,
        packages: config.pricing?.packages?.length || 0,
        packagesData: config.pricing?.packages,
      });

      // Convert to plain object and ensure packages are properly formatted
      const configObj = config.toObject ? config.toObject() : config;

      // Ensure pricing packages exist and are properly formatted
      if (!configObj.pricing) {
        configObj.pricing = { basePrice: 0, packages: [] };
      }
      if (!configObj.pricing.packages) {
        configObj.pricing.packages = [];
      }

      // Ensure each package has required fields
      configObj.pricing.packages = configObj.pricing.packages.map((pkg) => ({
        id: pkg.id || pkg._id?.toString(),
        name: pkg.name || '',
        price: pkg.price || 0,
        description: pkg.description || '',
        ...pkg,
      }));

      console.log(`✅ Final config for ${key}:`, {
        isActive: configObj.isActive,
        packagesCount: configObj.pricing.packages.length,
        packages: configObj.pricing.packages,
      });

      configMap[key] = configObj;
    });

    console.log(
      '🎯 Final config map sent to frontend:',
      Object.keys(configMap)
    );
    res.json(configMap);
  } catch (error) {
    console.error('❌ Get form configs error:', error);
    res.status(500).json({ error: 'Failed to fetch form configurations' });
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
