import {KotlinLexer} from "./parser/KotlinLexer";
import {StructurizrLexer} from "./parser/StructurizrLexer";
import {CharStreams, CommonTokenStream} from "antlr4ts";
import {KotlinParser, VariableReadContext} from "./parser/KotlinParser";
import {StructurizrParser} from "./parser/StructurizrParser";
import {CodeCompletionCore, ScopedSymbol, SymbolTable, VariableSymbol} from "antlr4-c3";
import {ParseTree, TerminalNode} from "antlr4ts/tree";
import {SymbolTableVisitorK} from "./symbol-table-visitor";
import {Symbol} from "antlr4-c3/out/src/SymbolTable";
import {CaretPosition, ComputeTokenPositionFunction, TokenPosition} from "./types";

export function getScope(context: ParseTree, symbolTable: SymbolTable): Symbol {
    if(!context) {
        return undefined;
    }
    const scope = symbolTable.symbolWithContextSync(context);
    if(scope) {
        return scope;
    } else {
        return getScope(context.parent, symbolTable);
    }
}

export function getAllSymbolsOfType<T extends Symbol>(scope: ScopedSymbol, type: new (...args: any[]) => T): T[] {
    let symbols = scope.getAllSymbolsSync(type, true);
    let parent = scope.parent;
    while(parent && !(parent instanceof ScopedSymbol)) {
        parent = parent.parent;
    }
    if(parent) {
        symbols.push(...getAllSymbolsOfType(parent as ScopedSymbol, type));
    }
    return symbols;
}

function suggestVariables(symbolTable: SymbolTable, position: TokenPosition): string[] {
    const context = position.context;
    const scope = getScope(context, symbolTable);
    let symbols: Symbol[];
    if(scope instanceof ScopedSymbol) { //Local scope
        symbols = getAllSymbolsOfType(scope, VariableSymbol);
    } else { //Global scope
        symbols = symbolTable.getAllSymbolsSync(VariableSymbol, false);
    }
    let variable = position.context;
    while(!(variable instanceof VariableReadContext) && variable.parent) {
        variable = variable.parent;
    }
    return filterTokens(variable ? position.text : '', symbols.map(s => s.name));
}

export function filterTokens_startsWith(text: string, candidates: string[]): string[] {
    if(text.trim().length == 0) {
        return candidates;
    } else {
        return candidates.filter(c => c.toLowerCase().startsWith(text.toLowerCase()));
    }
}

export let filterTokens = filterTokens_startsWith;
export function setTokenMatcher(fn) {
    filterTokens = fn;
}

export function getSuggestionsForParseTree(
    parser: StructurizrParser, parseTree: ParseTree, symbolTableFn: () => SymbolTable, position: TokenPosition): string[] {
    const core = new CodeCompletionCore(parser);
    let ignored: number[] = [];
    ignored.push(StructurizrParser.NL);
    // ignored.push(StructurizrParser.LBRACE, KotlinParser.QUOTE_CLOSE, KotlinParser.TRIPLE_QUOTE_OPEN)
    // ignored.push(KotlinParser.LabelDefinition, KotlinParser.LabelReference); //We don't handle labels for simplicity
    core.ignoredTokens = new Set(ignored);
    // core.preferredRules = new Set([KotlinParser.RULE_variableRead, KotlinParser.RULE_suggestArgument]);

    const candidates = core.collectCandidates(position.index);
    const completions: string[] = [];
    const tokens: string[] = [];

    candidates.tokens.forEach((_, k) => {
        if (k == StructurizrParser.ID) {
            //Skip, we’ve already handled it above
        // } else if (k == KotlinParser.NOT_IN) {
        //     tokens.push("!in");
        // } else if (k == KotlinParser.NOT_IS) {
        //     tokens.push("!is");
        } else {
            const symbolicName = parser.vocabulary.getSymbolicName(k);
            if (symbolicName) {
                tokens.push(symbolicName.toLowerCase());
            }
        }
    });
    const isIgnoredToken =
        position.context instanceof TerminalNode &&
        ignored.indexOf(position.context.symbol.type) >= 0;
    const textToMatch = isIgnoredToken ? '' : position.text;
    completions.push(...filterTokens(textToMatch, tokens));
    return completions;
}

export function getSuggestionsForParseTreeK(
    parser: KotlinParser, parseTree: ParseTree, symbolTableFn: () => SymbolTable, position: TokenPosition): string[] {
    let core = new CodeCompletionCore(parser);
    // Luckily, the Kotlin lexer defines all keywords and identifiers after operators,
    // so we can simply exclude the first non-keyword tokens
    let ignored = Array.from(Array(KotlinParser.FILE).keys());
    ignored.push(
        KotlinParser.BinLiteral, KotlinParser.BooleanLiteral, KotlinParser.CharacterLiteral, KotlinParser.DoubleLiteral,
        KotlinParser.HexLiteral, KotlinParser.IntegerLiteral, KotlinParser.LongLiteral, KotlinParser.NullLiteral,
        KotlinParser.RealLiteral,
        KotlinParser.DelimitedComment, KotlinParser.LineComment);
    ignored.push(KotlinParser.QUOTE_OPEN, KotlinParser.QUOTE_CLOSE, KotlinParser.TRIPLE_QUOTE_OPEN)
    ignored.push(KotlinParser.LabelDefinition, KotlinParser.LabelReference); //We don't handle labels for simplicity
    core.ignoredTokens = new Set(ignored);
    core.preferredRules = new Set([KotlinParser.RULE_variableRead, KotlinParser.RULE_suggestArgument]);
    let candidates = core.collectCandidates(position.index);

    let completions: string[] = [];
    if (candidates.rules.has(KotlinParser.RULE_variableRead) ||
        candidates.rules.has(KotlinParser.RULE_suggestArgument)) {
        completions.push(...suggestVariables(symbolTableFn(), position));
    }
    let tokens: string[] = [];
    candidates.tokens.forEach((_, k) => {
        if (k == KotlinParser.Identifier) {
            //Skip, we’ve already handled it above
        } else if (k == KotlinParser.NOT_IN) {
            tokens.push("!in");
        } else if (k == KotlinParser.NOT_IS) {
            tokens.push("!is");
        } else {
            const symbolicName = parser.vocabulary.getSymbolicName(k);
            if (symbolicName) {
                tokens.push(symbolicName.toLowerCase());
            }
        }
    });
    const isIgnoredToken =
        position.context instanceof TerminalNode &&
        ignored.indexOf(position.context.symbol.type) >= 0;
    const textToMatch = isIgnoredToken ? '' : position.text;
    completions.push(...filterTokens(textToMatch, tokens));
    return completions;
}

export function getSuggestions(
    code: string, caretPosition: CaretPosition, computeTokenPosition: ComputeTokenPositionFunction): string[] {
    let input = CharStreams.fromString(code);
    let lexer = new StructurizrLexer(input);
    let tokenStream = new CommonTokenStream(lexer);
    let parser = new StructurizrParser(tokenStream);

    let parseTree = parser.structurizrFile();

    let position = computeTokenPosition(parseTree, tokenStream, caretPosition);
    if(!position) {
        return [];
    }
    return getSuggestionsForParseTree(
        parser, parseTree, () => new SymbolTableVisitorK().visit(parseTree), position);
}

export function getSuggestionsK(
    code: string, caretPosition: CaretPosition, computeTokenPosition: ComputeTokenPositionFunction): string[] {
    let input = CharStreams.fromString(code);
    let lexer = new KotlinLexer(input);
    let tokenStream = new CommonTokenStream(lexer);
    let parser = new KotlinParser(tokenStream);

    let parseTree = parser.kotlinFile();

    let position = computeTokenPosition(parseTree, tokenStream, caretPosition);
    if(!position) {
        return [];
    }
    return getSuggestionsForParseTreeK(
        parser, parseTree, () => new SymbolTableVisitorK().visit(parseTree), position);
}