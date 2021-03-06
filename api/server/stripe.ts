import * as bodyParser from 'body-parser';
import Stripe from 'stripe';

import logger from './logs';
import Team from './models/Team';
import User from './models/User';
import { URL_API, URL_APP } from './consts';

import {
  STRIPE_LIVE_ENDPOINTSECRET as ENDPOINT_SECRET,
  STRIPE_PLANID as PLAN_ID,
  STRIPE_SECRETKEY as API_KEY,
} from './consts';

const stripeInstance = new Stripe(API_KEY, { apiVersion: '2020-03-02' });

function createSession({ userId, teamId, teamSlug, customerId, subscriptionId, userEmail, mode }) {
  const params: Stripe.Checkout.SessionCreateParams = {
    customer_email: customerId ? undefined : userEmail,
    customer: customerId,
    payment_method_types: ['card'],
    mode,
    success_url: `${URL_API}/stripe/checkout-completed/{CHECKOUT_SESSION_ID}`,
    cancel_url: `${URL_APP}/team/${teamSlug}/billing?checkout_canceled=1`,
    metadata: { userId, teamId },
  };

  if (mode === 'subscription') {
    params.line_items = [{ price: PLAN_ID, quantity: 1 }];
  } else if (mode === 'setup') {
    if (!customerId || !subscriptionId) {
      throw new Error('customerId and subscriptionId required');
    }

    params.setup_intent_data = {
      metadata: { customer_id: customerId, subscription_id: subscriptionId },
    };
  }

  return stripeInstance.checkout.sessions.create(params);
}

function retrieveSession({ sessionId }: { sessionId: string }) {
  return stripeInstance.checkout.sessions.retrieve(sessionId, {
    expand: [
      'setup_intent',
      'setup_intent.payment_method',
      'customer',
      'subscription',
      'subscription.default_payment_method',
    ],
  });
}

function createCustomer({ token, teamLeaderEmail, teamLeaderId }) {
  return stripeInstance.customers.create({
    description: 'Stripe Customer at saas-app.builderbook.org',
    email: teamLeaderEmail,
    source: token,
    metadata: {
      teamLeaderId,
    },
  });
}

function createSubscription({ customerId, teamId, teamLeaderId }) {
  logger.debug('stripe method is called', teamId, teamLeaderId);
  return stripeInstance.subscriptions.create({
    customer: customerId,
    items: [
      {
        plan: PLAN_ID,
      },
    ],
    metadata: {
      teamId,
      teamLeaderId,
    },
  });
}

function cancelSubscription({ subscriptionId }) {
  logger.debug('cancel subscription', subscriptionId);
  // eslint-disable-next-line
  return stripeInstance.subscriptions.del(subscriptionId);
}

function retrieveCard({ customerId, cardId }) {
  logger.debug(customerId);
  logger.debug(cardId);
  return stripeInstance.customers.retrieveSource(customerId, cardId);
}

function createNewCard({ customerId, token }) {
  logger.debug('creating new card', customerId);
  return stripeInstance.customers.createSource(customerId, { source: token });
}

function updateCustomer(customerId, params: Stripe.CustomerUpdateParams) {
  logger.debug('updating customer', customerId);
  // eslint-disable-next-line
  return stripeInstance.customers.update(customerId, params);
}

function updateSubscription(subscriptionId: string, params: Stripe.SubscriptionUpdateParams) {
  logger.debug('updating subscription', subscriptionId);
  return stripeInstance.subscriptions.update(subscriptionId, params);
}

function verifyWebHook(request) {
  const event = stripeInstance.webhooks.constructEvent(
    request.body,
    request.headers['stripe-signature'],
    ENDPOINT_SECRET,
  );
  return event;
}

function stripeWebHookAndCheckoutCallback({ server }) {
  server.post(
    '/api/v1/public/stripe-invoice-payment-failed',
    bodyParser.raw({ type: '*/*' }),
    async (req, res, next) => {
      try {
        const event = await verifyWebHook(req);
        // logger.info(JSON.stringify(event.data.object));

        // const { subscription } = event.data.object;
        // await Team.cancelSubscriptionAfterFailedPayment({
        //   subscriptionId: JSON.stringify(subscription),
        // });

        logger.info(event);

        res.sendStatus(200);
      } catch (err) {
        next(err);
      }
    },
  );

  server.get('/stripe/checkout-completed/:sessionId', async (req, res) => {
    try {
      const { sessionId } = req.params;

      const session = await retrieveSession({ sessionId });
      if (!session || !session.metadata || !session.metadata.userId || !session.metadata.teamId) {
        throw new Error('Wrong session.');
      }

      const user = await User.findById(
        session.metadata.userId,
        '_id stripeCustomer email displayName isSubscriptionActive stripeSubscription',
      ).setOptions({ lean: true });

      const team = await Team.findById(
        session.metadata.teamId,
        'isSubscriptionActive stripeSubscription teamLeaderId slug',
      ).setOptions({ lean: true });

      if (!user) {
        throw new Error('User not found.');
      }

      if (!team) {
        throw new Error('Team not found.');
      }

      if (team.teamLeaderId !== user._id.toString()) {
        throw new Error('Permission denied');
      }

      if (session.mode === 'setup' && session.setup_intent) {
        const si: Stripe.SetupIntent = session.setup_intent as Stripe.SetupIntent;
        const pm: Stripe.PaymentMethod = si.payment_method as Stripe.PaymentMethod;

        if (user.stripeCustomer) {
          await updateCustomer(user.stripeCustomer.id, {
            invoice_settings: { default_payment_method: pm.id },
          });
        }

        if (team.stripeSubscription) {
          await updateSubscription(team.stripeSubscription.id, { default_payment_method: pm.id });
        }

        await User.changeStripeCard({ session, user });
      } else if (session.mode === 'subscription') {
        await User.saveStripeCustomerAndCard({ session, user });
        await Team.subscribeTeam({ session, team });
        await User.getListOfInvoicesForCustomer({ userId: user._id });
      } else {
        throw new Error('Wrong session.');
      }

      res.redirect(`${URL_APP}/team/${team.slug}/billing`);
    } catch (err) {
      console.error(err);
      res.redirect(`${URL_APP}/your-settings?error=${err.message || err.toString()}`);
    }
  });
}

function getListOfInvoices({ customerId }) {
  logger.debug('getting list of invoices for customer', customerId);
  return stripeInstance.invoices.list({ customer: customerId, limit: 100 });
}

export {
  createSession,
  createCustomer,
  createSubscription,
  cancelSubscription,
  retrieveCard,
  createNewCard,
  updateCustomer,
  stripeWebHookAndCheckoutCallback,
  getListOfInvoices,
};
