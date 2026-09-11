import axios from 'axios';
import { logger } from './logger.js';
import { config } from '../config/env.js';

/**
 * Checks if there is rain at the given coordinates using Google Maps APIs or OpenWeatherMap (mockable).
 * Returns true if rain is detected, false otherwise.
 */
export async function isRainingAtLocation(lat, lng) {
    if (!lat || !lng) return false;

    // Use environment variable for Weather API key. 
    // This could be Google or OWM depending on the final production setup.
    const apiKey = config.weatherApiKey || process.env.WEATHER_API_KEY || config.googleMapsApiKey;

    if (!apiKey) {
        logger.warn('Weather API Key is not configured. Falling back to default (no rain).');
        // If testing/mocking, we could randomly return true or just return false to protect existing flow.
        return false;
    }

    try {
        // Example integration: Google or alternative
        // const response = await axios.get(`https://maps.googleapis.com/maps/api/weather...&key=${apiKey}`);
        
        // Mock fallback to OpenWeatherMap for robust testing if key provided is for OWM
        const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lng}&appid=${apiKey}`;
        const response = await axios.get(url, { timeout: 5000 });
        
        if (response.data && response.data.weather && response.data.weather.length > 0) {
            const conditionId = response.data.weather[0].id;
            // OWM condition codes: 2xx (Thunderstorm), 3xx (Drizzle), 5xx (Rain)
            if (conditionId >= 200 && conditionId < 600) {
                return true;
            }
        }
        return false;
    } catch (err) {
        logger.error(`Failed to fetch weather data: ${err.message}`);
        // Never break the existing flow on failure
        return false;
    }
}
