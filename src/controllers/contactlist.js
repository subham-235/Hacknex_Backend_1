const Contact=require("../models/contact");
const contactValidator=require("../utils/contactValidator");

const createContact = async (req, res) => {
    try {
        contactValidator(req.body);

        const { contacts, via, contactNumber } = req.body;

        const contact = await Contact.create({
            contacts,
            profileId: req.user._id,  
            via,
            contactNumber,
        });

        return res.status(201).json({
            message: "Contact created successfully",
            contact,
        });

    } catch (err) {
        return res.status(400).json({
            message: err.message,
        });
    }
};

// GET all contacts for logged in user
const getContacts = async (req, res) => {
    try {
        const profileId = req.user._id;

        const contacts = await Contact.find({ profileId })
            .sort({ priority: 1 });

        return res.status(200).json({
            success: true,
            count: contacts.length,
            contacts,
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

// DELETE a contact
const deleteContact = async (req, res) => {
    try {
        const { id } = req.params;
        const profileId = req.user._id;

        const contact = await Contact.findOneAndDelete({
            _id: id,
            profileId,
        });

        if (!contact) {
            return res.status(404).json({
                error: "Contact not found",
            });
        }

        return res.status(200).json({
            success: true,
            message: "Contact deleted",
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

// UPDATE a contact (toggle active/inactive)
const toggleContact = async (req, res) => {
    try {
        const { id } = req.params;
        const profileId = req.user._id;

        const contact = await Contact.findOne({ _id: id, profileId });

        if (!contact) {
            return res.status(404).json({
                error: "Contact not found",
            });
        }

        contact.isActive = !contact.isActive;
        await contact.save();

        return res.status(200).json({
            success: true,
            isActive: contact.isActive,
            message: `Contact ${contact.isActive ? "activated" : "deactivated"}`,
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
};

module.exports = {
    createContact,
    getContacts,
    deleteContact,
    toggleContact,
};

