// Basic server.js structure to tie your missing files together
require('dotenv').config();
const express = require('express');
const app = express();
const db = require('./db');
const middleware = require('./middleware');

app.use(express.static('public'));
app.use(middleware);

app.listen(process.env.PORT || 3000, () => {
    console.log("Server is running smoothly.");
});