const Parent = require('../models/Parent');
const Player = require('../models/Player');

async function replaceTemplateVariables(
  templateContent,
  { parentId, playerId }
) {
  let parent = null;
  let player = null;

  if (parentId) {
    parent = await Parent.findById(parentId).lean();
  }

  if (playerId) {
    player = await Player.findById(playerId).lean();

    // Extract first name from fullName if needed
    if (player?.fullName) {
      player.firstName = player.fullName.split(' ')[0];
    }
  }

  // Replace parent variables
  if (parent) {
    templateContent = templateContent.replace(
      /\[parent\.fullName\]/g,
      parent.fullName || ''
    );
    templateContent = templateContent.replace(
      /\[parent\.email\]/g,
      parent.email || ''
    );
    templateContent = templateContent.replace(
      /\[parent\.phone\]/g,
      parent.phone || ''
    );
  }

  // Replace player variables
  if (player) {
    templateContent = templateContent.replace(
      /\[player\.fullName\]/g,
      player.fullName || ''
    );
    templateContent = templateContent.replace(
      /\[player\.firstName\]/g,
      player.firstName || ''
    );
    templateContent = templateContent.replace(
      /\[player\.grade\]/g,
      player.grade || ''
    );
    templateContent = templateContent.replace(
      /\[player\.schoolName\]/g,
      player.schoolName || ''
    );
  }

  return templateContent;
}

module.exports = { replaceTemplateVariables };
