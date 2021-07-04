/**
 * what happens - Exchange cancels orders that lie outside execution range
 *
 * 1. SLM order can be partially filled before it gets cancelled
 * 2. Entire order can be cancelled
 *
 * Action plan:
 *
 * 1. Have a reference to the order id created by zerodha
 * 2. Every 5 seconds
 *  2. SLM order is in state `CANCELLED` or `COMPLETED`
 *  3. Cancel checker if `COMPLETED`
 *  4. Square off open position qty that was managed by this order_id
 *  5. If `Cancelled`, get the order history of this order_id,
 *    1. Get the item with status Cancelled.
 *    2. Fetch its cancelled_quantity
 *    3. Place a market exit order for cancelled_quantity for the tradingsymbol
 *    4. Add this new order back to this queue for monitoring
 *
 */

import { sample } from 'lodash';

import console from '../logging';
import { addToNextQueue, WATCHER_Q_NAME } from '../queue';
import orderResponse, {
  COMPLETED_ORDER_RESPONSE,
  NSE_OUT_OF_RANGE_ERROR_MOCKDATA,
  OPEN_POSITIONS_FOR_NSE_OUT_OF_RANGE_ERROR
} from '../strategies/mockData/orderResponse';
import { syncGetKiteInstance } from '../utils';

const MOCK_ORDERS = process.env.MOCK_ORDERS ? JSON.parse(process.env.MOCK_ORDERS) : false;

/**
 * [NB] IMPORTANT!
 * WATCH_MANUAL_CANCELLED_ORDERS is for testing this only!
 * DO NOT enable this env variable on your account!
 * e.g. in DOS, Khaching can itself cancel a pending order and create a new SLM order
 * if you were to enable this,
 * the position will get auto squared off as soon as Khaching cancels that pending order
 */
const WATCH_MANUAL_CANCELLED_ORDERS = process.env.WATCH_MANUAL_CANCELLED_ORDERS
  ? JSON.parse(process.env.WATCH_MANUAL_CANCELLED_ORDERS)
  : false;

const slmWatcher = async ({ slmOrderId, user, __queueJobData }) => {
  try {
    const kite = syncGetKiteInstance(user);
    const orderHistory = MOCK_ORDERS
      ? sample([NSE_OUT_OF_RANGE_ERROR_MOCKDATA, [COMPLETED_ORDER_RESPONSE]])
      : (await kite.getOrderHistory(slmOrderId)).reverse();
    const isOrderCompleted = orderHistory.find((order) => order.status === kite.STATUS_COMPLETE);
    if (isOrderCompleted) {
      return Promise.resolve('[slmWatcher] order COMPLETED!');
    }

    const cancelledOrder = orderHistory.find((order) =>
      order.status.includes(kite.STATUS_CANCELLED)
    );

    if (!cancelledOrder) {
      return Promise.reject('[slmWatcher] neither COMPLETED nor CANCELLED. Watching!');
    }

    const {
      cancelled_quantity: cancelledQty,
      status_message_raw: statusMessageRaw,
      transaction_type: transactionType,
      tradingsymbol,
      exchange,
      product
    } = cancelledOrder;

    /**
     * Conditions:
     * 1. WATCH_MANUAL_CANCELLED_ORDERS = false && statusMessageRaw = null
     *    true && true - returned
     *
     * 2. WATCH_MANUAL_CANCELLED_ORDERS = false && statusMessageRaw = '17070'
     *    true && false - continue
     *
     * 3. WATCH_MANUAL_CANCELLED_ORDERS = true && statusMessageRaw = null
     *    false && true - continue
     *
     * 4. WATCH_MANUAL_CANCELLED_ORDERS = true && statusMessageRaw = '17070'
     *    false && false - continue
     */

    if (
      !WATCH_MANUAL_CANCELLED_ORDERS &&
      statusMessageRaw !== '17070 : The Price is out of the current execution range'
    ) {
      return Promise.resolve('[slmWatcher] order cancelled by user!');
    }

    console.log('🟢 [slmWatcher] found cancelled SLM order!', {
      slmOrderId,
      cancelledQty,
      statusMessageRaw
    });

    if (cancelledQty) {
      const positions = MOCK_ORDERS
        ? OPEN_POSITIONS_FOR_NSE_OUT_OF_RANGE_ERROR
        : await kite.getPositions();

      const { net } = positions;
      const openPositionThatMustBeSquaredOff = net.find(
        (position) =>
          position.tradingsymbol === tradingsymbol &&
          position.product === product &&
          position.exchange === exchange &&
          Math.abs(position.quantity) >= cancelledQty
      );

      if (!openPositionThatMustBeSquaredOff) {
        return Promise.resolve('[slmWatcher] no open position to be squared off!');
      }

      console.log(
        '[slmWatcher] openPositionThatMustBeSquaredOff',
        openPositionThatMustBeSquaredOff
      );

      const exitOrder = {
        tradingsymbol,
        exchange,
        product,
        quantity: cancelledQty,
        transaction_type: transactionType,
        order_type: kite.ORDER_TYPE_MARKET,
        tag: __queueJobData.initialJobData.orderTag
      };

      console.log('[slmWatcher] placing exit order', exitOrder);
      const rawKiteOrderResponse = MOCK_ORDERS
        ? orderResponse[0]
        : await kite.placeOrder(kite.VARIETY_REGULAR, exitOrder);
      // add this job back to the watcher queue to ensure it succeeds
      try {
        await addToNextQueue(__queueJobData.initialJobData, {
          __nextTradingQueue: WATCHER_Q_NAME,
          rawKiteOrderResponse
        });
      } catch (e) {
        console.log('[slmWatcher] error adding watcher for new exit market order', e);
      }
      return Promise.resolve('[slmWatcher] placing exit order');
    }
  } catch (e) {
    console.log('🔴 [slmWatcher] error. Checker terminated!!', e);
    // a promise reject here could be dangerous due to retry logic.
    // It could lead to multiple exit orders for the same initial order_id
    // hence, resolve
    return Promise.resolve('[slmWatcher] error');
  }
};

export default slmWatcher;
