import type { AppContext } from 'react-native-screen-context';

/** Tells the assistant what this app is, before it looks at any screen. */
export const APP_CONTEXT: AppContext = {
  name: 'Methai Demo',
  description: 'A small grocery shop app: sign in, add groceries to a cart, apply a coupon and check out. Prices are in Indian rupees.',
  screens: [
    { name: 'Login', description: 'Sign in with email and password, with an optional "Remember me"', howToReach: 'the "Login tab" button in the bottom bar' },
    { name: 'Shop', description: 'Product list with + / − quantity buttons, a coupon field, the total and Checkout', howToReach: 'the "Shop tab" button in the bottom bar' },
    { name: 'Settings', description: 'Order notification and promotional offer switches', howToReach: 'the "Settings tab" button in the bottom bar' },
  ],
  flows: [
    { name: 'Place an order', steps: 'Shop tab → press "Add one <product>" once per unit → optionally type a coupon → Checkout' },
    { name: 'Sign in', steps: 'Login tab → type email → type password → optionally turn on Remember me → Log in' },
  ],
  instructions: 'Coupons are spoken as words ("save ten" means SAVE10). Quantities are set by pressing the add button repeatedly.',
};
