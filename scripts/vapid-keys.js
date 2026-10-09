// Prints a new VAPID key pair for Web Push, as lines for the environment
// (PROD_ENV). Changing the pair later invalidates every existing device
// subscription (they re-subscribe on their next visit).
import { generateVapidKeys } from '../core/webpush.js';

const { publicKey, privateKey } = generateVapidKeys();
console.log(`VAPID_PUBLIC_KEY=${publicKey}\nVAPID_PRIVATE_KEY=${privateKey}\nVAPID_SUBJECT=mailto:tech@unicorndev.eu`);
