const Parent = require('../models/Parent');
const Player = require('../models/Player');
const PlayerRegistration = require('../models/PlayerRegistration');
const Payment = require('../models/Payment');
const Team = require('../models/Team');

async function getParentByEmail(email) {
  const parent = await Parent.findOne({
    email: email.toLowerCase().trim(),
  }).lean();

  if (!parent) return null;

  return {
    id: parent._id.toString(),
    fullName: parent.fullName,
    email: parent.email,
    phone: parent.phone,
    role: parent.role,
  };
}

async function getFamilyData(parentId) {
  const players = await Player.find({ parentId }).lean();

  const playerIds = players.map((p) => p._id);

  const registrations = await PlayerRegistration.find({
    playerId: { $in: playerIds },
  }).lean();

  const payments = await Payment.find({ parentId })
    .sort({ createdAt: -1 })
    .lean();

  const teamIds = [
    ...new Set(
      registrations
        .map((r) => r.teamId)
        .filter(Boolean)
        .map((id) => id.toString()),
    ),
  ];

  const teams = await Team.find({
    _id: { $in: teamIds },
  }).lean();

  return {
    players,
    registrations,
    payments,
    teams,
  };
}

module.exports = {
  getParentByEmail,
  getFamilyData,
};
