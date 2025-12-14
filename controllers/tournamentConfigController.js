// backend/controllers/tournamentConfigController.js
const TournamentConfig = require('../models/TournamentConfig');

// Get all tournament configs
exports.getTournamentConfigs = async (req, res) => {
  try {
    const configs = await TournamentConfig.find().sort({
      tournamentYear: -1,
      tournamentName: 1,
    });
    res.json(configs);
  } catch (error) {
    console.error('❌ Error getting tournament configs:', error);
    res.status(500).json({ error: error.message });
  }
};

// Create or update tournament config
exports.updateTournamentConfig = async (req, res) => {
  try {
    const config = req.body;

    console.log('🏀 Updating tournament config:', config);

    // Validate required fields
    if (!config.tournamentName || !config.tournamentYear) {
      return res.status(400).json({
        error: 'Tournament name and year are required',
      });
    }

    // Check if we have an original tournament name (if name is being changed)
    const originalTournamentName =
      req.body.originalTournamentName || config.tournamentName;

    // Find by ORIGINAL tournament name (in case name changed)
    const existingConfig = await TournamentConfig.findOne({
      tournamentName: originalTournamentName,
    });

    if (existingConfig) {
      // Update existing config
      // If tournament name changed, we need to handle it specially
      if (originalTournamentName !== config.tournamentName) {
        // Check if new name already exists
        const nameExists = await TournamentConfig.findOne({
          tournamentName: config.tournamentName,
          _id: { $ne: existingConfig._id }, // Exclude current document
        });

        if (nameExists) {
          return res.status(400).json({
            error: 'Tournament name already exists',
          });
        }
      }

      // Update the document
      Object.assign(existingConfig, config);
      existingConfig.updatedAt = new Date();
      await existingConfig.save();
      console.log('✅ Tournament config updated:', existingConfig);
      res.json(existingConfig);
    } else {
      // Create new config - but first check if name already exists
      const nameExists = await TournamentConfig.findOne({
        tournamentName: config.tournamentName,
      });

      if (nameExists) {
        return res.status(400).json({
          error: 'Tournament name already exists',
        });
      }

      const newConfig = new TournamentConfig(config);
      await newConfig.save();
      console.log('✅ Tournament config created:', newConfig);
      res.json(newConfig);
    }
  } catch (error) {
    console.error('❌ Error updating tournament config:', error);
    res.status(500).json({ error: error.message });
  }
};

// Get specific tournament config by name
exports.getTournamentConfig = async (req, res) => {
  try {
    const { tournamentName } = req.params;
    const config = await TournamentConfig.findOne({ tournamentName });

    if (config) {
      console.log('✅ Found tournament config:', config);
      res.json(config);
    } else {
      console.log('📭 No tournament config found for:', tournamentName);
      res.status(404).json({ message: 'Tournament configuration not found' });
    }
  } catch (error) {
    console.error('❌ Error getting tournament config:', error);
    res.status(500).json({ error: error.message });
  }
};

// Delete tournament config
exports.deleteTournamentConfig = async (req, res) => {
  try {
    const { tournamentName } = req.params;
    const config = await TournamentConfig.findOneAndDelete({ tournamentName });

    if (config) {
      console.log('🗑️ Tournament config deleted:', tournamentName);
      res.json({ message: 'Tournament configuration deleted successfully' });
    } else {
      res.status(404).json({ message: 'Tournament configuration not found' });
    }
  } catch (error) {
    console.error('❌ Error deleting tournament config:', error);
    res.status(500).json({ error: error.message });
  }
};
