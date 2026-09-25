const express = require("express");
const userMiddleware = require("../middleware/userMiddleware");
const contactAuth = express.Router();
const {
    createContact,
    getContacts,
    deleteContact,
    toggleContact,
} = require("../controllers/contactlist");

contactAuth.post("/create", userMiddleware, createContact);
contactAuth.get("/list", userMiddleware, getContacts);
contactAuth.delete("/delete/:id", userMiddleware, deleteContact);
contactAuth.patch("/toggle/:id", userMiddleware, toggleContact);

module.exports = contactAuth;
