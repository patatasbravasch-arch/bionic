const WORD_RE = /\p{L}[\p{L}\p{M}\p{N}'’\-]*/gu;
const ENTITY_RE = /^&(?:#\d+|#x[\da-f]+|[a-z][a-z0-9]+);/i;
const VOID_HTML_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
    'link', 'meta', 'param', 'source', 'track', 'wbr',
]);
const graphemeSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;
function graphemes(value) {
    if (!graphemeSegmenter)
        return Array.from(value);
    return Array.from(graphemeSegmenter.segment(value), part => part.segment);
}
function fixationLength(length) {
    if (length <= 1)
        return 0;
    return Math.max(1, Math.ceil(length * 0.5));
}
function transformPlainText(text) {
    return text.replace(WORD_RE, (word) => {
        const units = graphemes(word);
        const cut = fixationLength(units.length);
        if (cut <= 0 || cut >= units.length)
            return word;
        const fixed = units.slice(0, cut).join('');
        const rest = units.slice(cut).join('');
        return `<span class="lumibionic-fix">${fixed}</span>${rest}`;
    });
}
function readHtmlTag(source, start) {
    if (source[start] !== '<')
        return null;
    if (source.startsWith('<!--', start)) {
        const close = source.indexOf('-->', start + 4);
        return {
            end: close < 0 ? source.length : close + 3,
            name: null,
            closing: false,
            selfClosing: true,
        };
    }
    if (source.startsWith('<!', start) || source.startsWith('<?', start)) {
        const close = source.indexOf('>', start + 2);
        return {
            end: close < 0 ? source.length : close + 1,
            name: null,
            closing: false,
            selfClosing: true,
        };
    }
    let cursor = start + 1;
    let closing = false;
    if (source[cursor] === '/') {
        closing = true;
        cursor++;
    }
    const nameStart = cursor;
    while (cursor < source.length && /[A-Za-z0-9:-]/.test(source[cursor]))
        cursor++;
    if (cursor === nameStart || !/[A-Za-z]/.test(source[nameStart]))
        return null;
    const name = source.slice(nameStart, cursor).toLowerCase();
    let quote = null;
    while (cursor < source.length) {
        const char = source[cursor];
        if (quote) {
            if (char === quote)
                quote = null;
        }
        else if (char === '"' || char === "'") {
            quote = char;
        }
        else if (char === '>') {
            const before = source.slice(start, cursor).trimEnd();
            return {
                end: cursor + 1,
                name,
                closing,
                selfClosing: before.endsWith('/') || VOID_HTML_TAGS.has(name),
            };
        }
        cursor++;
    }
    return null;
}
function findRawHtmlElementEnd(source, start) {
    const opening = readHtmlTag(source, start);
    if (!opening)
        return null;
    if (!opening.name || opening.closing || opening.selfClosing)
        return opening.end;
    let depth = 1;
    let cursor = opening.end;
    while (cursor < source.length) {
        const next = source.indexOf('<', cursor);
        if (next < 0)
            break;
        const tag = readHtmlTag(source, next);
        if (!tag) {
            cursor = next + 1;
            continue;
        }
        if (tag.name === opening.name) {
            if (tag.closing)
                depth--;
            else if (!tag.selfClosing)
                depth++;
            if (depth === 0)
                return tag.end;
        }
        cursor = tag.end;
    }
    // If the HTML is malformed, protect only the opening tag and continue with prose.
    return opening.end;
}
function countRun(source, start, char) {
    let count = 0;
    while (source[start + count] === char)
        count++;
    return count;
}
function findFenceBlockEnd(source, start) {
    if (start > 0 && source[start - 1] !== '\n')
        return null;
    let cursor = start;
    let spaces = 0;
    while (spaces < 4 && (source[cursor] === ' ' || source[cursor] === '\t')) {
        spaces++;
        cursor++;
    }
    if (spaces > 3)
        return null;
    const marker = source[cursor];
    if (marker !== '`' && marker !== '~')
        return null;
    const markerLength = countRun(source, cursor, marker);
    if (markerLength < 3)
        return null;
    const openingLineEnd = source.indexOf('\n', cursor + markerLength);
    if (openingLineEnd < 0)
        return source.length;
    cursor = openingLineEnd + 1;
    while (cursor < source.length) {
        const lineStart = cursor;
        let p = lineStart;
        let indent = 0;
        while (indent < 4 && (source[p] === ' ' || source[p] === '\t')) {
            indent++;
            p++;
        }
        if (indent <= 3 && source[p] === marker) {
            const run = countRun(source, p, marker);
            if (run >= markerLength) {
                let rest = p + run;
                while (source[rest] === ' ' || source[rest] === '\t')
                    rest++;
                if (source[rest] === '\n')
                    return rest + 1;
                if (rest >= source.length)
                    return source.length;
            }
        }
        const nextLine = source.indexOf('\n', cursor);
        if (nextLine < 0)
            return source.length;
        cursor = nextLine + 1;
    }
    return source.length;
}
function findInlineCodeEnd(source, start) {
    if (source[start] !== '`')
        return null;
    const run = countRun(source, start, '`');
    const delimiter = '`'.repeat(run);
    const close = source.indexOf(delimiter, start + run);
    return close < 0 ? start + run : close + run;
}
function findClosingBracket(source, start, open, close) {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
        if (source[i] === '\\') {
            i++;
            continue;
        }
        if (source[i] === open)
            depth++;
        else if (source[i] === close) {
            depth--;
            if (depth === 0)
                return i + 1;
        }
    }
    return null;
}
function findImageTokenEnd(source, start) {
    if (!source.startsWith('![', start))
        return null;
    const altEnd = findClosingBracket(source, start + 1, '[', ']');
    if (!altEnd)
        return null;
    if (source[altEnd] === '(') {
        return findClosingBracket(source, altEnd, '(', ')') ?? altEnd;
    }
    if (source[altEnd] === '[') {
        return findClosingBracket(source, altEnd, '[', ']') ?? altEnd;
    }
    return altEnd;
}
function findUrlEnd(source, start) {
    const isUrl = source.startsWith('https://', start)
        || source.startsWith('http://', start)
        || source.startsWith('mailto:', start);
    if (!isUrl)
        return null;
    let cursor = start;
    while (cursor < source.length && !/\s/.test(source[cursor]))
        cursor++;
    return cursor;
}
function findAutolinkEnd(source, start) {
    if (source[start] !== '<')
        return null;
    const innerStart = start + 1;
    const isAuto = source.startsWith('https://', innerStart)
        || source.startsWith('http://', innerStart)
        || source.startsWith('mailto:', innerStart);
    if (!isAuto)
        return null;
    const close = source.indexOf('>', innerStart);
    return close < 0 ? source.length : close + 1;
}
function findLinkDestinationEnd(source, start) {
    if (source[start] === '(' && start > 0 && source[start - 1] === ']') {
        return findClosingBracket(source, start, '(', ')');
    }
    if (source[start] === '[' && start > 0 && source[start - 1] === ']') {
        return findClosingBracket(source, start, '[', ']');
    }
    return null;
}
/**
 * Adds fixation spans to Markdown prose while leaving syntax-sensitive regions alone.
 * This function is intentionally conservative: raw HTML elements are protected as a
 * whole, rather than attempting to rewrite text inside arbitrary HTML islands.
 */
export function transformMarkdownForBionic(source) {
    if (!source || source.includes('class="lumibionic-fix"'))
        return source;
    let output = '';
    let prose = '';
    let cursor = 0;
    const flushProse = () => {
        if (!prose)
            return;
        output += transformPlainText(prose);
        prose = '';
    };
    const protect = (end) => {
        flushProse();
        output += source.slice(cursor, end);
        cursor = end;
    };
    while (cursor < source.length) {
        const fenceEnd = findFenceBlockEnd(source, cursor);
        if (fenceEnd !== null) {
            protect(fenceEnd);
            continue;
        }
        const imageEnd = findImageTokenEnd(source, cursor);
        if (imageEnd !== null) {
            protect(imageEnd);
            continue;
        }
        const autolinkEnd = findAutolinkEnd(source, cursor);
        if (autolinkEnd !== null) {
            protect(autolinkEnd);
            continue;
        }
        const htmlEnd = findRawHtmlElementEnd(source, cursor);
        if (htmlEnd !== null) {
            protect(htmlEnd);
            continue;
        }
        const inlineCodeEnd = findInlineCodeEnd(source, cursor);
        if (inlineCodeEnd !== null) {
            protect(inlineCodeEnd);
            continue;
        }
        const linkDestinationEnd = findLinkDestinationEnd(source, cursor);
        if (linkDestinationEnd !== null) {
            protect(linkDestinationEnd);
            continue;
        }
        const urlEnd = findUrlEnd(source, cursor);
        if (urlEnd !== null) {
            protect(urlEnd);
            continue;
        }
        if (source[cursor] === '&') {
            const entity = source.slice(cursor).match(ENTITY_RE)?.[0];
            if (entity) {
                protect(cursor + entity.length);
                continue;
            }
        }
        // Keep Markdown escapes together so an escaped punctuation mark remains escaped.
        if (source[cursor] === '\\' && cursor + 1 < source.length) {
            flushProse();
            output += source.slice(cursor, cursor + 2);
            cursor += 2;
            continue;
        }
        prose += source[cursor];
        cursor++;
    }
    flushProse();
    return output;
}
