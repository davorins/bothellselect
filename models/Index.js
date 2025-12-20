const mongoose = require('mongoose');

const Tournament = require('./Tournament');
const Team = require('./Team');
const Match = require('./Match');
const Standing = require('./Standing');
const Parent = require('./Parent');

module.exports = {
  Tournament,
  Team,
  Match,
  Standing,
  Parent,
};
