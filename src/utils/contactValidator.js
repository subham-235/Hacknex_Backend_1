const validator = require("validator");

const contactValidator = (data) => {
    const { contacts, via, contactNumber } = data;

    if (!contacts || !via || !contactNumber) {
        throw new Error("All fields are required.");
    }

    if (!["WhatsApp", "SMS"].includes(via)) {
        throw new Error("Invalid contact method.");
    }

    if (!validator.isMobilePhone(contactNumber, "en-IN")) {
        throw new Error("Invalid contact number.");
    }
};

module.exports = contactValidator;