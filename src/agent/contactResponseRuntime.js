const { createContactResponses } = require('./contactResponses');
module.exports = createContactResponses({
  Session: require('../models/emergencySession'),
  Contact: require('../models/contact'),
  notify: event => require('../coordination/runtime').notify(event),
});
