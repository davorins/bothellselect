// controllers/tryoutConfigController.js
const TryoutConfig = require('../models/TryoutConfig');

// Get all tryout configs
exports.getTryoutConfigs = async (req, res) => {
  try {
    const configs = await TryoutConfig.find().sort({
      tryoutYear: -1,
      tryoutName: 1,
    });

    // Ensure tryoutDetails exists for each config (backward compatibility)
    const configsWithDefaults = configs.map((config) => {
      const configObj = config.toObject();

      // Add default tryoutDetails if missing
      if (!configObj.tryoutDetails) {
        configObj.tryoutDetails = {
          startDate: '',
          endDate: '',
          duration: '',
          gender: '',
          days: [],
          locations: [],
          tryoutSessions: [],
          notes: [],
          dropOffTime: '',
          pickUpTime: '',
          hasLimitedSpots: false,
          contactEmail: '',
          ageGroups: [],
          maxParticipants: null,
          whatToBring: [],
        };
      }

      return configObj;
    });

    console.log(
      'Backend tryout configs:',
      configs.map((c) => ({
        tryoutName: c.tryoutName,
        hasTryoutDetails: !!c.tryoutDetails,
        tryoutDetails: c.tryoutDetails,
      })),
    );

    res.json(configsWithDefaults);
  } catch (error) {
    console.error('❌ Error getting tryout configs:', error);
    res.status(500).json({ error: error.message });
  }
};

// Create or update tryout config
exports.updateTryoutConfig = async (req, res) => {
  try {
    const config = req.body;
    const originalTryoutName = config.originalTryoutName || config.tryoutName;

    console.log('🎯 Updating tryout config:', {
      config,
      description: config.description,
      descriptionLength: config.description?.length,
      hasTryoutDetails: !!config.tryoutDetails,
      originalTryoutName,
    });

    // Validate required fields including season link
    if (!config.tryoutName || !config.tryoutYear) {
      return res.status(400).json({
        error: 'Tryout name and year are required',
      });
    }

    // Validate season link
    if (!config.eventId || !config.season) {
      return res.status(400).json({
        error:
          'Tryout must be linked to a season (eventId and season are required)',
      });
    }

    // Find by ORIGINAL tryout name (in case name changed)
    const existingConfig = await TryoutConfig.findOne({
      tryoutName: originalTryoutName,
    });

    if (existingConfig) {
      // Update existing config
      if (originalTryoutName !== config.tryoutName) {
        const nameExists = await TryoutConfig.findOne({
          tryoutName: config.tryoutName,
          _id: { $ne: existingConfig._id },
        });

        if (nameExists) {
          return res.status(400).json({
            error: 'Tryout name already exists',
          });
        }
      }

      const { originalTryoutName: omit, ...updates } = config;

      // Convert string dates to Date objects
      if (updates.registrationDeadline) {
        updates.registrationDeadline = new Date(updates.registrationDeadline);
      }
      if (updates.paymentDeadline) {
        updates.paymentDeadline = new Date(updates.paymentDeadline);
      }

      // ✅ Ensure description is set (even if empty string)
      updates.description = updates.description || '';

      // ✅ IMPORTANT: Include tryoutDetails if it exists
      if (updates.tryoutDetails) {
        console.log(
          '📝 Saving tryoutDetails:',
          JSON.stringify(updates.tryoutDetails, null, 2),
        );
      }

      console.log('🔄 Applying updates to existing config:', {
        updates,
        description: updates.description,
        descriptionLength: updates.description?.length,
        tryoutDetails: updates.tryoutDetails ? 'present' : 'missing',
      });

      // Update the document
      Object.keys(updates).forEach((key) => {
        existingConfig[key] = updates[key];
      });

      existingConfig.updatedAt = new Date();

      const savedConfig = await existingConfig.save();

      console.log('✅ Tryout config updated:', {
        id: savedConfig._id,
        tryoutName: savedConfig.tryoutName,
        description: savedConfig.description,
        descriptionLength: savedConfig.description?.length,
        hasTryoutDetails: !!savedConfig.tryoutDetails,
      });

      res.json(savedConfig);
    } else {
      // Create new config
      const nameExists = await TryoutConfig.findOne({
        tryoutName: config.tryoutName,
      });

      if (nameExists) {
        return res.status(400).json({
          error: 'Tryout name already exists',
        });
      }

      // Create new config with all fields
      const newConfigData = { ...config };
      delete newConfigData.originalTryoutName;

      // Convert string dates to Date objects
      if (newConfigData.registrationDeadline) {
        newConfigData.registrationDeadline = new Date(
          newConfigData.registrationDeadline,
        );
      }
      if (newConfigData.paymentDeadline) {
        newConfigData.paymentDeadline = new Date(newConfigData.paymentDeadline);
      }

      // Ensure description is set
      newConfigData.description = newConfigData.description || '';

      // tryoutDetails will be included automatically from the config

      console.log('🆕 Creating new config:', {
        newConfigData,
        description: newConfigData.description,
        descriptionLength: newConfigData.description?.length,
        hasTryoutDetails: !!newConfigData.tryoutDetails,
      });

      const newConfig = new TryoutConfig(newConfigData);
      const savedConfig = await newConfig.save();

      console.log('✅ Tryout config created:', {
        id: savedConfig._id,
        tryoutName: savedConfig.tryoutName,
        description: savedConfig.description,
        descriptionLength: savedConfig.description?.length,
        hasTryoutDetails: !!savedConfig.tryoutDetails,
      });

      res.json(savedConfig);
    }
  } catch (error) {
    console.error('❌ Error updating tryout config:', error);
    console.error('Error details:', error.message);
    res.status(500).json({
      error: 'Failed to save tryout configuration',
      details: error.message,
    });
  }
};

// Get tryouts by season
exports.getTryoutsBySeason = async (req, res) => {
  try {
    const { eventId, season, year } = req.query;

    let query = {};
    if (eventId) {
      query.eventId = eventId;
    }
    if (season) {
      query.season = season;
    }
    if (year) {
      query.tryoutYear = parseInt(year);
    }

    const tryouts = await TryoutConfig.find(query).sort({ tryoutYear: -1 });

    // Add default tryoutDetails if missing
    const tryoutsWithDefaults = tryouts.map((tryout) => {
      const obj = tryout.toObject();
      if (!obj.tryoutDetails) {
        obj.tryoutDetails = {
          startDate: '',
          endDate: '',
          duration: '',
          gender: '',
          days: [],
          locations: [],
          tryoutSessions: [],
          notes: [],
          dropOffTime: '',
          pickUpTime: '',
          hasLimitedSpots: false,
          contactEmail: '',
          ageGroups: [],
          maxParticipants: null,
          whatToBring: [],
        };
      }
      return obj;
    });

    res.json(tryoutsWithDefaults);
  } catch (error) {
    console.error('Error getting tryouts by season:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get specific tryout config by name
exports.getTryoutConfig = async (req, res) => {
  try {
    const { tryoutName } = req.params;
    const config = await TryoutConfig.findOne({ tryoutName });

    if (config) {
      const configObj = config.toObject();
      // Add default tryoutDetails if missing
      if (!configObj.tryoutDetails) {
        configObj.tryoutDetails = {
          startDate: '',
          endDate: '',
          duration: '',
          gender: '',
          days: [],
          locations: [],
          tryoutSessions: [],
          notes: [],
          dropOffTime: '',
          pickUpTime: '',
          hasLimitedSpots: false,
          contactEmail: '',
          ageGroups: [],
          maxParticipants: null,
          whatToBring: [],
        };
      }

      console.log('✅ Found tryout config:', {
        tryoutName: configObj.tryoutName,
        description: configObj.description,
        descriptionLength: configObj.description?.length,
        hasTryoutDetails: !!configObj.tryoutDetails,
      });
      res.json(configObj);
    } else {
      console.log('📭 No tryout config found for:', tryoutName);
      res.status(404).json({ message: 'Tryout configuration not found' });
    }
  } catch (error) {
    console.error('❌ Error getting tryout config:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete tryout config
exports.deleteTryoutConfig = async (req, res) => {
  try {
    const { tryoutName } = req.params;
    const config = await TryoutConfig.findOneAndDelete({ tryoutName });

    if (config) {
      console.log('🗑️ Tryout config deleted:', tryoutName);
      res.json({ message: 'Tryout configuration deleted successfully' });
    } else {
      res.status(404).json({ message: 'Tryout configuration not found' });
    }
  } catch (error) {
    console.error('❌ Error deleting tryout config:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get tryout config by eventId
exports.getTryoutConfigByEventId = async (req, res) => {
  try {
    const { eventId } = req.params;
    const config = await TryoutConfig.findOne({ eventId });

    if (config) {
      const configObj = config.toObject();
      // Add default tryoutDetails if missing
      if (!configObj.tryoutDetails) {
        configObj.tryoutDetails = {
          startDate: '',
          endDate: '',
          duration: '',
          gender: '',
          days: [],
          locations: [],
          tryoutSessions: [],
          notes: [],
          dropOffTime: '',
          pickUpTime: '',
          hasLimitedSpots: false,
          contactEmail: '',
          ageGroups: [],
          maxParticipants: null,
          whatToBring: [],
        };
      }

      console.log('✅ Found tryout config by eventId:', {
        eventId,
        tryoutName: configObj.tryoutName,
        description: configObj.description,
        descriptionLength: configObj.description?.length,
        hasTryoutDetails: !!configObj.tryoutDetails,
      });
      res.json(configObj);
    } else {
      console.log('📭 No tryout config found for eventId:', eventId);
      res
        .status(404)
        .json({ message: 'Tryout configuration not found for this event' });
    }
  } catch (error) {
    console.error('❌ Error getting tryout config by eventId:', error);
    res.status(500).json({ error: error.message });
  }
};
