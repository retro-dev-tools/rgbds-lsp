export interface SymbolDef {
    name: string;
    type: 'label' | 'constant' | 'macro' | 'section' | 'charmap';
    file: string;
    line: number;
    col: number;
    endCol: number;
    isLocal: boolean;
    isExported: boolean;
    parentLabel?: string;
    docComment?: string;
    value?: string;
}

export interface SymbolRef {
    name: string;
    file: string;
    line: number;
    col: number;
    endCol: number;
}

export interface IncludeRef {
    from: string;
    line: number;
    col: number;
    endCol: number;
}

/** A single CHARMAP entry: source string → byte values + definition location */
export interface CharmapEntry {
    source: string;
    bytes: number[];
    file: string;
    line: number;
}

/** Charmap state change at a specific file position */
export interface CharmapStateChange {
    line: number;
    charmap: string;
}

/** A segment of a charmap-encoded string */
export interface CharmapSegment {
    source: string;
    bytes: number[];
    isMte: boolean;
}
