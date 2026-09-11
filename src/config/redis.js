const { createClient } = require('redis');
const { redisOptions } = require('./redisOptions');
const options = redisOptions();

const redisClient = createClient({
    ...options,
    socket: {
        ...options.socket,
        reconnectStrategy: (retries) => {
            if (retries > 10) {
                console.error("Redis: too many reconnect attempts, giving up.");
                return new Error("Redis reconnect failed");
            }
            
            
            
            
            // exponential backoff, capped at 3s
            return Math.min(retries * 100, 3000);
        }
    }
});

redisClient.on('error', (err) => {
    console.error('Redis Client Error:', err.message);
});

redisClient.on('reconnecting', () => {
    console.log('Redis: reconnecting...');
});

redisClient.on('connect', () => {
    console.log('Redis: connected');
});

module.exports = redisClient;
