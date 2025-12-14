const TryoutConfig = require('../models/TryoutConfig');

// Get all tryout configs
exports.getTryoutConfigs = async (req, res) => {
  try {
    const configs = await TryoutConfig.find().sort({
      tryoutYear: -1,
      tryoutName: 1,
    });
    res.json(configs);
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

    console.log('🏀 Updating tryout config:', {
      config,
      originalTryoutName,
    });

    // Validate required fields
    if (!config.tryoutName || !config.tryoutYear) {
      return res.status(400).json({
        error: 'Tryout name and year are required',
      });
    }

    // Find by ORIGINAL tryout name (in case name changed)
    const existingConfig = await TryoutConfig.findOne({
      tryoutName: originalTryoutName,
    });

    if (existingConfig) {
      // Update existing config
      if (originalTryoutName !== config.tryoutName) {
        // Check if new name already exists
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

      // Remove originalTryoutName from config before saving
      const { originalTryoutName: _, ...configToSave } = config;

      // Update the document
      Object.assign(existingConfig, configToSave);
      existingConfig.updatedAt = new Date();
      await existingConfig.save();

      console.log('✅ Tryout config updated:', existingConfig);
      res.json(existingConfig);
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

      // Remove originalTryoutName from config before saving
      const { originalTryoutName: _, ...configToSave } = config;

      const newConfig = new TryoutConfig(configToSave);
      await newConfig.save();
      console.log('✅ Tryout config created:', newConfig);
      res.json(newConfig);
    }
  } catch (error) {
    console.error('❌ Error updating tryout config:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get specific tryout config by name
exports.getTryoutConfig = async (req, res) => {
  try {
    const { tryoutName } = req.params;
    const config = await TryoutConfig.findOne({ tryoutName });

    if (config) {
      console.log('✅ Found tryout config:', config);
      res.json(config);
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
