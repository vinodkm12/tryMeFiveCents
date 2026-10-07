import * as kalshiGenerics from "./kalshiGenerics";
import * as allFillModule from "./all_fills";
import * as tableModule from "./table_input_separate";
import * as fs from "node:fs";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

export function writeCsv(filename: string, values: Record<string, string[]>): void {
    const columns = Object.keys(values);
    const row_count = values[columns[0]].length;

    const rows = Array.from({ length: row_count }, (_, row) =>
        Object.fromEntries(columns.map(column => [column, values[column][row]]))
    );

    const csv = stringify(rows, {
        header: true,
        columns,
    });

    fs.writeFileSync(filename, csv);
}

export function readCsv(filename: string): Record<string, string[]> {
    const text = fs.readFileSync(filename, "utf8");

    const rows: Record<string, string>[] = parse(text, {
        columns: true,
        skip_empty_lines: true,
    });

    const result: Record<string, string[]> = {};

    for (const row of rows) {
        for (const [column, value] of Object.entries(row)) {
            result[column] ??= [];
            result[column].push(value);
        }
    }
    return result;
}

export function alignOutputValuesByTicker(
    tickers: string[],
    outputColumns: string[],
    savedValues: Record<string, string[]>,
): Record<string, string[]> {
    const savedRowByTicker = new Map(
        (savedValues.ticker ?? []).map((ticker, row) => [ticker, row])
    );

    return Object.fromEntries(outputColumns.map(column => [
        column,
        tickers.map(ticker => {
            const savedRow = savedRowByTicker.get(ticker);
            return savedRow === undefined ? "" : (savedValues[column]?.[savedRow] ?? "");
        }),
    ]));
}

export function calculateMarketROC(
    market: allFillModule.Market,
    current_streams: number,
    min_monthly_streams: number,
): boolean {
    const noBids = market.full_order_book?.no_bids ?? [];
    if (noBids.length === 0 || min_monthly_streams <= 0) return false;

    const tickerNumStreams = Number(market.ticker.split("-").at(-1)!.slice(0, -1));
    if (!Number.isFinite(tickerNumStreams)) return false;

    const noTopPrice = Math.min(noBids.at(-1)![0] + 0.01, 0.99);
    const expectedTimeToFill = (tickerNumStreams - current_streams) / min_monthly_streams;
    if (expectedTimeToFill <= 0) return false;

    const expectedRoc = (1 - noTopPrice) / expectedTimeToFill;

    return expectedRoc >= 0.01;
}

async function main(): Promise<void> {
    // 1. Auth and get all streams markets in different data structures
    const auth = kalshiGenerics.loadKalshiAuth("./MyAPIKey1.txt");
    const base_url = "https://kalshi.com/markets/kx/test/";
    const markets_without_order_books = await allFillModule.getAllMarkets(auth, "KXARTISTSTREAMSY");
    const all_markets: readonly allFillModule.Market[] = await Promise.all(
        markets_without_order_books.map(market => allFillModule.loadOrderBook(auth, market))
    );
    const all_events : string[] = [...new Set(all_markets.map(x => x.event_ticker))];
    const all_urls : string[] = all_events.map(x => base_url + x);
    const all_market_map: Record<string, allFillModule.Market[]> = {};
    for (const market of all_markets) {
        all_market_map[market.ticker] ??= [];
        all_market_map[market.ticker].push(market);
    }

    // 2. Pull data from the table
    const input_values: Record<string, string[]> = {
        ticker: all_events,
        url: all_urls,
    };
    const min_monthly_streams_column = "Lowest possible monthly streams";
    const current_streams_column = "Current streams";
    const output_columns = [min_monthly_streams_column, current_streams_column];
    const output_values: Record<string, string[]> = {};
    const saved_values = fs.existsSync("output.csv") ? readCsv("output.csv") : {};
    const initial_output_values = alignOutputValuesByTicker(
        all_events,
        output_columns,
        saved_values,
    );

    await tableModule.runTableInputServer(
        3000,
        input_values,
        output_columns,
        output_values,
        initial_output_values,
    );

    // 3. Store the ticker with each output so future API ordering does not matter.
    writeCsv("output.csv", {
        ticker: all_events,
        ...output_values,
    });

    const event_ticker_data = new Map(all_events.map((event_ticker, row) => [
        event_ticker,
        {
            min_monthly_streams: Number(output_values[min_monthly_streams_column][row]),
            current_streams: Number(output_values[current_streams_column][row]),
        },
    ]));

    const good_markets = Object.values(all_market_map)
        .flat()
        .filter(market => {
            const event_data = event_ticker_data.get(market.event_ticker);
            if (event_data === undefined) return false;
            if (!Number.isFinite(event_data.current_streams)) return false;
            if (!Number.isFinite(event_data.min_monthly_streams)) return false;

            return calculateMarketROC(
                market,
                event_data.current_streams,
                event_data.min_monthly_streams,
            );
        });

    console.log("Good markets:", good_markets.map(market => market.ticker));

}

main().catch((error: unknown) => {
    console.error("Application failed:", error);
    process.exitCode = 1;
});
