import type { KalshiAuth, RetrieveError } from "./kalshiGenerics";
import { callKalshiApi } from "./kalshiGenerics";

export type MarketTicker = string;
export type EventTicker = string;
export type ISODate = string;

export type Result<T, E> = { readonly kind: "Ok"; readonly value: T } | { readonly kind: "Err"; readonly error: E };

export interface Fill {
    readonly ticker: MarketTicker;
    readonly created_time: string;
    readonly yes_price_dollars: string | number;
    readonly count_fp: string | number;
    readonly is_taker: boolean;
    readonly [key: string]: unknown;
}

export interface AugmentedFill extends Omit<Fill, "yes_price_dollars"> {
    readonly event_ticker: EventTicker;
    readonly title: string;
    readonly date: ISODate;
    readonly yes_price_dollars: number;
    readonly no_price_dollars: number;
    readonly count: number;
    readonly fee: number;
}

export interface PaginatedResponse<T> {
    readonly items: readonly T[];
    readonly cursor: string;
}

export interface Market {
    readonly event_ticker: EventTicker;
    readonly ticker: MarketTicker;
    readonly title: string;
    readonly full_order_book?: FullOrderBook;
}

export interface EventTickerMaps {
    readonly eventTickerMap: ReadonlyMap<MarketTicker, EventTicker>;
    readonly titleMap: ReadonlyMap<MarketTicker, string>;
}

export interface FullOrderBook {
    readonly yes_bids: [number, number][];
    readonly no_bids: [number, number][];
    readonly bids : [number, number][];
    readonly asks : [number, number][];
}

export function isRetrieveError(value: unknown): value is RetrieveError {
    return typeof value === "object" && value !== null && "kind" in value && value.kind === "RetrieveError";
}

export async function getAllFills(auth: KalshiAuth): Promise<readonly Fill[]> {
    const portfolioFills = await collectPaginated<Fill>(auth, ["portfolio", "fills"], "fills");
    const historicalFills = await collectPaginated<Fill>(auth, ["historical", "fills"], "fills");

    return [...portfolioFills, ...historicalFills];
}

export async function getAllMarkets(auth: KalshiAuth, series_ticker?: string): Market[] {
    
    const markets : readonly Market[] = await collectPaginated<Market>(auth, ["markets"], "markets",
                                            {status: "open", series_ticker: series_ticker, limit: "1000"});

    return markets;
}

export async function collectPaginated<T>(auth: KalshiAuth, endpoint: readonly string[], collectionKey: string, params: any = {}): T[] {
    const items: T[] = [];
    let cursor = "";
    do {
        const response = await callKalshiApi<PaginatedResponse<T>>(auth, endpoint, {[collectionKey]: "items"},
                                                                    { ...params, cursor });
        items.push(...(response.items as T[]));
        cursor = response.cursor;
    } while (cursor !== "");

    return items;
}

export async function getEventTickerTitle(auth: KalshiAuth, ticker: MarketTicker): Promise<Market> {
    const liveResult = await callKalshiApi<Market>(auth, ["markets", ticker], { ticker });
    if (!isRetrieveError(liveResult))
        return liveResult;

    const historicalResult = await callKalshiApi<Market>(auth, ["historical", "markets", ticker], { ticker });

    return historicalResult;
}

export async function getEventTickerMap(auth: KalshiAuth, allFills: readonly Fill[]): Promise<Result<EventTickerMaps, RetrieveError>> {
    const eventTickerMap = new Map<MarketTicker, EventTicker>();
    const titleMap = new Map<MarketTicker, string>();
    console.log("All fills is ", allFills)
    const tickerSet = new Set(allFills.map(fill => fill.ticker));

    console.log(`${tickerSet.size} tickers to process.`);

    let index = 0;

    for (const ticker of tickerSet) {
        if (index % 200 === 0) console.log(`Processed ${index} market tickers in getEventTickerMap.`);

        const result = await getEventTickerTitle(auth, ticker);
        if (result.kind === "Err") return result;

        eventTickerMap.set(ticker, result.value.event_ticker);
        titleMap.set(ticker, result.value.title);
        index += 1;
    }

    return { kind: "Ok", value: { eventTickerMap, titleMap } };
}

export function augmentAllFills(allFills: readonly Fill[], maps: EventTickerMaps): Result<readonly AugmentedFill[], Error> {
    const augmented: AugmentedFill[] = [];

    for (const fill of allFills) {
        const eventTicker = maps.eventTickerMap.get(fill.ticker);
        const title = maps.titleMap.get(fill.ticker);

        if (eventTicker === undefined) return { kind: "Err", error: new Error(`Missing event ticker for ${fill.ticker}`) };
        if (title === undefined) return { kind: "Err", error: new Error(`Missing title for ${fill.ticker}`) };

        const yesPriceDollars = Number(fill.yes_price_dollars);
        const noPriceDollars = 1 - yesPriceDollars;
        const count = Number(fill.count_fp);
        const date = new Date(fill.created_time).toISOString().slice(0, 10);
        const fee = calculateFee(fill.is_taker, eventTicker, yesPriceDollars, noPriceDollars, count);

        augmented.push({ ...fill, event_ticker: eventTicker, title, date, yes_price_dollars: yesPriceDollars, no_price_dollars: noPriceDollars, count, fee });
    }

    return { kind: "Ok", value: augmented };
}

export function calculateFee(isTaker: boolean, eventTicker: EventTicker, yesPrice: number, noPrice: number, count: number): number {
    if (!isTaker) return 0;
    if (eventTicker.startsWith("PRES") || eventTicker.startsWith("SENATE") || eventTicker.startsWith("HOUSE")) return 0;
    if (eventTicker.startsWith("KXINX")) return Math.ceil(3.5 * yesPrice * noPrice * count);
    return Math.ceil(7 * yesPrice * noPrice * count);
}

export type MarketStatus = "active" | "closed" | "finalized" | "inactive" | string;
export type MarketResult = "yes" | "no" | string;
export type FillSide = "yes" | "no";

export interface MarketWithMarks {
    readonly status: MarketStatus;
    readonly result?: MarketResult | null;
    readonly yes_bid?: number | null;
    readonly yes_ask?: number | null;
    readonly no_bid?: number | null;
    readonly no_ask?: number | null;
}

export interface MarketWithMarksResponse {
    readonly market: MarketWithMarks;
}

export type MarketMarks =
    | { readonly kind: "Marked"; readonly yes: number; readonly no: number }
    | { readonly kind: "Cancelled" };

export interface PnlFill extends AugmentedFill {
    readonly side: FillSide;
}

export interface TickerPnlWorking {
    num_yes: number;
    mean_yes_px: number;
    num_no: number;
    mean_no_px: number;
    event_ticker: EventTicker;
    date_list: readonly string[];
    fees: number;
    cancelled: boolean;
    title: string;
    yes_mark?: number;
    no_mark?: number;
    date?: string;
    pnl?: number;
}

export type TickerPnlMap = Readonly<Record<MarketTicker, TickerPnlWorking>>;

export async function markTicker(auth: KalshiAuth, ticker: MarketTicker): Promise<Result<MarketMarks, RetrieveError>> {
    const result = await callKalshiApi<MarketWithMarksResponse>(auth, ["markets", ticker], { ticker });
    if (isRetrieveError(result)) return { kind: "Err", error: result };

    const info = result.market;

    if (info.status === "inactive") return { kind: "Ok", value: { kind: "Cancelled" } };

    if (info.status === "finalized") {
        return { kind: "Ok", value: { kind: "Marked", yes: info.result === "yes" ? 100 : 0, no: info.result === "no" ? 100 : 0 } };
    }

    if (info.status === "active" || info.status === "closed") {
        const yes = midpointMark(info.yes_bid ?? null, info.yes_ask ?? null);
        const no = midpointMark(info.no_bid ?? null, info.no_ask ?? null);
        return { kind: "Ok", value: { kind: "Marked", yes, no } };
    }

    return { kind: "Ok", value: { kind: "Cancelled" } };
}

function midpointMark(bid: number | null, ask: number | null): number {
    if (ask === null) return 100;
    if (bid === null) return 0;
    return (bid + ask) / 2;
}

export async function getPnlsByTicker(auth: KalshiAuth, allFills: readonly PnlFill[]): Promise<Result<TickerPnlMap, RetrieveError>> {
    const tickerPnls: Record<MarketTicker, TickerPnlWorking> = {};

    for (const fill of allFills) {
        if (!(fill.ticker in tickerPnls)) {
            const marksResult = await markTicker(auth, fill.ticker);
            if (marksResult.kind === "Err") return marksResult;

            tickerPnls[fill.ticker] = {
                num_yes: 0,
                mean_yes_px: 0,
                num_no: 0,
                mean_no_px: 0,
                event_ticker: fill.event_ticker,
                date_list: [],
                fees: 0,
                cancelled: false,
                title: fill.title,
            };

            if (marksResult.value.kind === "Cancelled") {
                tickerPnls[fill.ticker].cancelled = true;
                continue;
            }

            tickerPnls[fill.ticker].yes_mark = marksResult.value.yes;
            tickerPnls[fill.ticker].no_mark = marksResult.value.no;
        }

        if (tickerPnls[fill.ticker].cancelled) continue;

        const yesPrice = fill.yes_price_dollars * 100;
        const noPrice = fill.no_price_dollars * 100;

        if (fill.side === "yes") {
            const currentSumProduct = tickerPnls[fill.ticker].mean_yes_px * tickerPnls[fill.ticker].num_yes;
            const nextNumYes = tickerPnls[fill.ticker].num_yes + fill.count;

            tickerPnls[fill.ticker].mean_yes_px = (currentSumProduct + fill.count * yesPrice) / nextNumYes;
            tickerPnls[fill.ticker].num_yes = nextNumYes;
        }

        if (fill.side === "no") {
            const currentSumProduct = tickerPnls[fill.ticker].mean_no_px * tickerPnls[fill.ticker].num_no;
            const nextNumNo = tickerPnls[fill.ticker].num_no + fill.count;

            tickerPnls[fill.ticker].mean_no_px = (currentSumProduct + fill.count * noPrice) / nextNumNo;
            tickerPnls[fill.ticker].num_no = nextNumNo;
        }

        tickerPnls[fill.ticker].fees += fill.fee;
        tickerPnls[fill.ticker].date_list = [...tickerPnls[fill.ticker].date_list, fill.date];
    }

    for (const ticker of Object.keys(tickerPnls)) {
        const tickerPnl = tickerPnls[ticker];

        if (tickerPnl.cancelled) continue;
        if (tickerPnl.yes_mark === undefined || tickerPnl.no_mark === undefined) continue;

        tickerPnl.date = mode(tickerPnl.date_list);

        let pnl = 0;
        pnl += (100 - tickerPnl.mean_yes_px - tickerPnl.mean_no_px) * Math.min(tickerPnl.num_yes, tickerPnl.num_no);

        if (tickerPnl.num_yes > tickerPnl.num_no) {
            pnl += (tickerPnl.num_yes - tickerPnl.num_no) * (tickerPnl.yes_mark - tickerPnl.mean_yes_px);
        } else {
            pnl += (tickerPnl.num_no - tickerPnl.num_yes) * (tickerPnl.no_mark - tickerPnl.mean_no_px);
        }

        tickerPnl.pnl = pnl - tickerPnl.fees;
    }

    return { kind: "Ok", value: tickerPnls };
}

function mode(values: readonly string[]): string {
    const counts = new Map<string, number>();

    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

    let bestValue = "";
    let bestCount = -1;

    for (const [value, count] of counts.entries()) {
        if (count > bestCount) {
            bestValue = value;
            bestCount = count;
        }
    }

    return bestValue;
}

export interface MutexFill extends AugmentedFill {
    readonly side: "yes" | "no";
}

export interface OrderbookResponse {
    readonly orderbook_fp: {
        readonly yes_dollars: readonly [number, number][];
        readonly no_dollars: readonly [number, number][];
    };
}

export interface OrdersResponse {
    readonly orders: readonly Order[];
}

export interface Order {
    readonly order_id: string;
    readonly side: "yes" | "no";
    readonly status: string;
    readonly initial_count_fp: string | number;
    readonly fill_count_fp: string | number;
    readonly no_price_dollars: string | number;
}

export interface QueuePositionResponse {
    readonly queue_position_fp: string | number;
}

export interface RestingNoOrder {
    readonly remainingCount: number;
    readonly noPriceDollars: number;
    readonly queuePosition: number;
}

export interface MutexTickerWorking {
    noFilledCount: number;
    noFilledAvgCost: number;
    yesFilledCount: number;
    yesFilledAvgCost: number;
    marketNoPrice?: number;
    marketNoSize?: number;
    myRestingNoCount?: number;
    myRestingNoPrice?: number;
    myQueuePosition?: number;
}

export interface MutexNoRow {
    readonly contractTitle: string;
    readonly ticker: MarketTicker;
    readonly noFilledCount: number;
    readonly yesFilledCount: number;
    readonly netNoFilledCount: number;
    readonly noFilledAvgCost: number;
    readonly yesFilledAvgCost: number;
    readonly realizedPnl: number;
    readonly noFilledCheapness: number;
    readonly marketNoPrice: number;
    readonly marketNoSize: number;
    readonly myRestingNoCount: number | "";
    readonly myRestingNoPrice: number | "";
    readonly myQueuePosition: number | "";
}

export async function getMutexNoRows(
    auth: KalshiAuth,
    allFills: readonly MutexFill[],
    eventTicker: EventTicker,
    titleMap: ReadonlyMap<MarketTicker, string>,
): Promise<Result<readonly MutexNoRow[], RetrieveError>> {
    const mutexFills = allFills.filter(fill => fill.event_ticker === eventTicker);
    const mutexTickerData: Record<MarketTicker, MutexTickerWorking> = {};

    for (const fill of mutexFills) {
        if (!(fill.ticker in mutexTickerData)) {
            mutexTickerData[fill.ticker] = { noFilledCount: 0, noFilledAvgCost: 0, yesFilledCount: 0, yesFilledAvgCost: 0 };
        }

        addFillToMutexTickerData(mutexTickerData[fill.ticker], fill);
    }

    for (const ticker of Object.keys(mutexTickerData)) {
        const result = await getMarketNoBestBid(auth, ticker);
        if (result.kind === "Err") return result;

        mutexTickerData[ticker].marketNoPrice = result.value.price;
        mutexTickerData[ticker].marketNoSize = result.value.size;
    }

    for (const ticker of Object.keys(mutexTickerData)) {
        const result = await getTopRestingNoOrder(auth, ticker);
        if (result.kind === "Err") return result;

        mutexTickerData[ticker].myRestingNoCount = result.value?.remainingCount;
        mutexTickerData[ticker].myRestingNoPrice = result.value?.noPriceDollars;
        mutexTickerData[ticker].myQueuePosition = result.value?.queuePosition;
    }

    return { kind: "Ok", value: Object.entries(mutexTickerData).map(([ticker, data]) => mutexNoRow(ticker, data, titleMap)) };
}

function addFillToMutexTickerData(data: MutexTickerWorking, fill: MutexFill): void {
    const side = fill.side;
    const count = fill.count;
    const price = side === "yes" ? fill.yes_price_dollars : fill.no_price_dollars;
    const feeDollars = fill.fee / 100;
    const fillCost = price * Number(fill.count_fp) + feeDollars;

    if (side === "yes") {
        const currentTotalCost = data.yesFilledCount * data.yesFilledAvgCost;
        data.yesFilledCount += count;
        data.yesFilledAvgCost = (currentTotalCost + fillCost) / data.yesFilledCount;
    } else {
        const currentTotalCost = data.noFilledCount * data.noFilledAvgCost;
        data.noFilledCount += count;
        data.noFilledAvgCost = (currentTotalCost + fillCost) / data.noFilledCount;
    }
}

async function getMarketNoBestBid(auth: KalshiAuth, ticker: MarketTicker): Promise<Result<{ readonly price: number; readonly size: number }, RetrieveError>> {
    const result = await callKalshiApi<OrderbookResponse>(auth, ["markets", ticker, "orderbook"]);
    if (isRetrieveError(result)) return { kind: "Err", error: result };

    const bestBid = maxPriceLevel(result.orderbook_fp.no_dollars);
    return { kind: "Ok", value: { price: bestBid[0], size: bestBid[1] } };
}

export async function getFullOrderBook(auth: KalshiAuth, ticker: MarketTicker,): Promise<FullOrderBook> {
    const result = await callKalshiApi<OrderbookResponse>(auth, ["markets", ticker, "orderbook"]);
    const yes_bids = result.orderbook_fp.yes_dollars
        .map(([price, size]): [number, number] => [Number(price), Number(size)])
        .sort(([leftPrice], [rightPrice]) => leftPrice - rightPrice);
    const no_bids = result.orderbook_fp.no_dollars
        .map(([price, size]): [number, number] => [Number(price), Number(size)])
        .sort(([leftPrice], [rightPrice]) => leftPrice - rightPrice);

    return {
        yes_bids,
        no_bids,
        bids: yes_bids,
        asks: no_bids
            .map(([noPrice, size]): [number, number] => [1 - Number(noPrice), Number(size)])
            .sort(([leftPrice], [rightPrice]) => leftPrice - rightPrice),
    };
}

export async function loadOrderBook(auth: KalshiAuth, market: Market): Promise<Market> {
    const full_order_book = await getFullOrderBook(auth, market.ticker);
    return { ...market, full_order_book };
}

function maxPriceLevel(levels: readonly [number, number][]): readonly [number, number] {
    if (levels.length === 0) return [0, 0];

    return levels.reduce((best, level) => level[0] > best[0] ? level : best);
}

async function getTopRestingNoOrder(auth: KalshiAuth, ticker: MarketTicker): Promise<Result<RestingNoOrder | undefined, RetrieveError>> {
    const result = await callKalshiApi<OrdersResponse>(auth, ["portfolio", "orders"], { ticker });
    if (isRetrieveError(result)) return { kind: "Err", error: result };

    let topOrder: RestingNoOrder | undefined = undefined;

    for (const order of result.orders) {
        if (order.side !== "no" || order.status !== "resting") continue;

        const queueResult = await getOrderQueuePosition(auth, order.order_id);
        if (queueResult.kind === "Err") return queueResult;

        const restingOrder: RestingNoOrder = {
            remainingCount: Math.round(Number(order.initial_count_fp) - Number(order.fill_count_fp)),
            noPriceDollars: Number(order.no_price_dollars),
            queuePosition: queueResult.value,
        };

        if (topOrder === undefined || restingOrder.queuePosition < topOrder.queuePosition) topOrder = restingOrder;
    }

    return { kind: "Ok", value: topOrder };
}

async function getOrderQueuePosition(auth: KalshiAuth, orderId: string): Promise<Result<number, RetrieveError>> {
    const result = await callKalshiApi<QueuePositionResponse>(auth, ["portfolio", "orders", orderId, "queue_position"]);
    if (isRetrieveError(result)) return { kind: "Err", error: result };

    return { kind: "Ok", value: Number(result.queue_position_fp) };
}

function mutexNoRow(ticker: MarketTicker, data: MutexTickerWorking, titleMap: ReadonlyMap<MarketTicker, string>): MutexNoRow {
    return {
        contractTitle: titleMap.get(ticker) ?? "",
        ticker,
        noFilledCount: data.noFilledCount,
        yesFilledCount: data.yesFilledCount,
        netNoFilledCount: data.noFilledCount - data.yesFilledCount,
        noFilledAvgCost: data.noFilledAvgCost,
        yesFilledAvgCost: data.yesFilledAvgCost,
        realizedPnl: data.yesFilledCount * (1 - data.yesFilledAvgCost - data.noFilledAvgCost),
        noFilledCheapness: 1 - data.noFilledAvgCost,
        marketNoPrice: data.marketNoPrice ?? 0,
        marketNoSize: data.marketNoSize ?? 0,
        myRestingNoCount: data.myRestingNoCount ?? "",
        myRestingNoPrice: data.myRestingNoPrice ?? "",
        myQueuePosition: data.myQueuePosition ?? "",
    };
}
