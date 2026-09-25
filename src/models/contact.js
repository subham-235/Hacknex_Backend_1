const mongoose = require("mongoose");
const { Schema } = mongoose;

const contactSchema = new Schema({
    contacts: {
        type: String,
        required: true,
        enum: [
            "Family",
            "Father",
            "Mother",
            "Brother",
            "Sister",
            "Local Police Station",
            "Other Contacts",
        ],
        default: "Family",
    },

    profileId: {
        type: Schema.Types.ObjectId,
        ref: "user",
        required: true,
    },

    via: {
        type: String,
        required: true,
        enum: ["WhatsApp", "SMS"],
        default: "SMS",
    },

    createdAt: {
        type: Date,
        default: Date.now,
    },

    contactNumber: {
        type: String,
        required: true,
        trim: true,
        match: /^[0-9]{10}$/,
    },

    priority: {
        type: Number,
        default: 1,
    },
    isActive: {
        type: Boolean,
        default: true,
    },
});

module.exports = mongoose.model("contact", contactSchema);