const jwt = require("jsonwebtoken");
const User = require("../models/user");
const redisClient = require("../config/redis");

async function adminMiddleware(req, res, next) {
    try {
        const token = req.cookies.token;

        if (!token) {
            return res.status(401).send("Token not found.");
        }

        const payload = jwt.verify(token, process.env.JWT_KEY);

        if (payload.role !== "admin") {
            return res.status(403).send("User is not an admin.");
        }

        const user = await User.findById(payload._id);

        if (!user) {
            return res.status(404).send("No user found.");
        }

        const isBlocked = await redisClient.exists(`token:${token}`);

        if (isBlocked) {
            return res.status(401).send("Token is blocked.");
        }

        req.user = user;

        next();

    } catch (err) {
        return res.status(401).send(err.message);
    }
}

module.exports = adminMiddleware;