declare module "accepts" {
  interface AcceptsRequest {
    headers: {
      accept?: string;
    };
  }

  interface AcceptsInstance {
    types<T extends string>(types: T[]): T | false;
  }

  export default function accepts(request: AcceptsRequest): AcceptsInstance;
}

declare module "csv-stringify/lib/sync.js" {
  interface CsvStringifyOptions {
    header?: boolean;
  }

  export default function csvStringifySync(
    records: unknown[],
    options?: CsvStringifyOptions,
  ): string;
}

declare module "easyxml" {
  interface EasyXmlOptions {
    rootElement?: string;
    dateFormat?: "ISO" | "SQL" | "JS";
    manifest?: boolean;
    attributePrefix?: string | false;
  }

  export default class EasyXml {
    constructor(options?: EasyXmlOptions);
    render(value: unknown): string;
  }
}
