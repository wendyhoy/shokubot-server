const express = require('express');
const router = express.Router();

const UsersController = require('../../../controllers/api/v1/users_controller');

// Handle api request to show specific user
// VERB: GET
// PATH: /api/v1/users/:id
router.get('/:id', UsersController.show);


module.exports = router;
