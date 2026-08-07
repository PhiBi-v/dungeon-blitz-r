#!/usr/bin/env node
/**
 * Regenerate the East Wing (JC_Mini2) canonical spawn table from LevelsJC.swf.
 *
 * WHY THIS EXISTS (and why exportTheEastWingEnemies.js is not enough):
 * that script reads the rooms' decompiled ActionScript and picks up
 * `public var __idNNN_:ac_Type` declarations. Only cues that were given an instance
 * name in Flash get such a declaration — **30 of the East Wing's 35 hostiles are
 * placed on the room timeline with no instance name**, so they are invisible to it.
 * The result was a 5-enemy table while the client happily spawned all 35, and every
 * unnamed enemy ended up as a per-client `clientSpawned` entity that only one player
 * could see.
 *
 * This script instead walks the SWF tag structure directly:
 *   DefineSprite(a_Level_JCMini2) -> PlaceObject2/3 -> the four a_Room_JCMini2_0N sprites
 *   DefineSprite(room)            -> PlaceObject2/3 -> every placed ac_* instance
 * and adds the room's placement MATRIX translation to each instance's own, giving
 * absolute world pixels.
 *
 * Verified against the live client: the X coordinates produced here match the
 * positions the Flash client reports for its own local spawns exactly (±1px). Y is the
 * authored position and can sit up to ~70px above the client's, which settles the
 * entity onto the floor — well inside the server's 400px proxy match radius.
 *
 * Usage: node src/server/tools/exportEastWingEnemiesFromDisplayList.js [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const repoRoot = path.resolve(__dirname, '../../..');
const swfPath = path.join(repoRoot, 'src/client/content/localhost/p/cbp/LevelsJC.swf');
const outputPath = path.join(__dirname, '../data/dungeonSpawns/levelsJC_the_east_wing.enemies.json');

const LEVEL_CHARACTER = 'a_Level_JCMini2';
const ROOM_SYMBOLS = { 1: 2197, 2: 2195, 3: 2201, 4: 2193 };
const CANONICAL_ID_BASE = 920000;
const BOSS_TYPE = 'TowerGuard2';
const BOSS_DISPLAY_NAME = 'Tanja, The 2nd Daughter';
// Placed on the hostile layer but not enemies — they must stay out of the roster or
// full-clear can never complete.
const NON_HOSTILE = /TreasureChest|Chest|Dummy|Target|Objective|Helper|Parrot/i;

function readSwf(file) {
    let data = fs.readFileSync(file);
    const signature = data.slice(0, 3).toString('ascii');
    if (signature === 'CWS') {
        data = Buffer.concat([Buffer.from('FWS'), data.slice(3, 8), zlib.inflateSync(data.slice(8))]);
    } else if (signature !== 'FWS') {
        throw new Error(`Unsupported SWF signature ${signature} in ${file}`);
    }
    return data;
}

/** Bit reader for SWF's packed MATRIX records. */
class BitReader {
    constructor(buffer, byteOffset) {
        this.buffer = buffer;
        this.bit = byteOffset * 8;
    }
    unsigned(count) {
        let value = 0;
        for (let i = 0; i < count; i++) {
            value = (value << 1) | ((this.buffer[this.bit >> 3] >> (7 - (this.bit & 7))) & 1);
            this.bit++;
        }
        return value >>> 0;
    }
    signed(count) {
        if (!count) return 0;
        const value = this.unsigned(count);
        return (value & (1 << (count - 1))) ? value - (1 << count) : value;
    }
}

/** Returns the MATRIX translation in pixels (SWF stores twips). */
function readMatrixTranslation(data, offset) {
    const reader = new BitReader(data, offset);
    if (reader.unsigned(1)) { const n = reader.unsigned(5); reader.signed(n); reader.signed(n); }
    if (reader.unsigned(1)) { const n = reader.unsigned(5); reader.signed(n); reader.signed(n); }
    const n = reader.unsigned(5);
    return { x: reader.signed(n) / 20, y: reader.signed(n) / 20 };
}

function parseTags(data) {
    let offset = 8;
    const nbits = data[offset] >> 3;
    offset += Math.ceil((5 + nbits * 4) / 8);
    offset += 4; // frame rate + frame count

    const sprites = new Map();
    const names = new Map();
    let i = offset;
    while (i < data.length - 1) {
        const header = data.readUInt16LE(i);
        i += 2;
        const code = header >> 6;
        let length = header & 0x3f;
        if (length === 0x3f) { length = data.readUInt32LE(i); i += 4; }
        const body = i;
        const bodyEnd = i + length;

        if (code === 39) { // DefineSprite
            sprites.set(data.readUInt16LE(body), { start: body + 4, end: bodyEnd });
        } else if (code === 76) { // SymbolClass
            const count = data.readUInt16LE(body);
            let q = body + 2;
            for (let k = 0; k < count; k++) {
                const characterId = data.readUInt16LE(q);
                q += 2;
                const start = q;
                while (data[q] !== 0) q++;
                names.set(characterId, data.slice(start, q).toString('latin1'));
                q++;
            }
        }
        i = bodyEnd;
    }
    return { sprites, names };
}

/** Every PlaceObject2/3 inside a sprite, with its character name and translation. */
function placedChildren(data, sprites, names, spriteId) {
    const sprite = sprites.get(spriteId);
    if (!sprite) return [];

    const out = [];
    let i = sprite.start;
    while (i < sprite.end - 1) {
        const header = data.readUInt16LE(i);
        i += 2;
        const code = header >> 6;
        let length = header & 0x3f;
        if (length === 0x3f) { length = data.readUInt32LE(i); i += 4; }
        const body = i;
        const bodyEnd = i + length;

        if (code === 26 || code === 70) { // PlaceObject2 / PlaceObject3
            let q = body;
            const flags = data[q];
            q++;
            let flags2 = 0;
            if (code === 70) { flags2 = data[q]; q++; }
            const depth = data.readUInt16LE(q);
            q += 2;
            if (code === 70 && (flags2 & 8)) { while (data[q] !== 0) q++; q++; } // className
            let characterId = null;
            if (flags & 2) { characterId = data.readUInt16LE(q); q += 2; }
            let translation = { x: 0, y: 0 };
            if (flags & 4) translation = readMatrixTranslation(data, q);
            if (characterId !== null) {
                out.push({
                    characterId,
                    name: names.get(characterId) || `char${characterId}`,
                    x: translation.x,
                    y: translation.y,
                    depth
                });
            }
        }
        i = bodyEnd;
    }
    return out;
}

function main() {
    const dryRun = process.argv.includes('--dry-run');
    const data = readSwf(swfPath);
    const { sprites, names } = parseTags(data);

    let levelCharacterId = null;
    for (const [characterId, name] of names) {
        if (name === LEVEL_CHARACTER) levelCharacterId = characterId;
    }
    if (levelCharacterId === null) throw new Error(`${LEVEL_CHARACTER} not found in ${swfPath}`);

    const roomOffsets = {};
    for (const child of placedChildren(data, sprites, names, levelCharacterId)) {
        const match = child.name.match(/^a_Room_JCMini2_(\d+)$/);
        if (match) roomOffsets[Number(match[1])] = { x: child.x, y: child.y };
    }

    const previous = fs.existsSync(outputPath)
        ? JSON.parse(fs.readFileSync(outputPath, 'utf8').replace(/^﻿/, ''))
        : { enemies: [] };
    // Carry authored metadata (speech lines, source vars) across regenerations.
    const previousByKey = new Map(
        (previous.enemies || []).map((enemy) => [`${enemy.type}|${Math.round(enemy.x)}`, enemy])
    );

    const enemies = [];
    for (const roomId of [1, 2, 3, 4]) {
        const offset = roomOffsets[roomId] || { x: 0, y: 0 };
        for (const child of placedChildren(data, sprites, names, ROOM_SYMBOLS[roomId])) {
            if (!/^ac_/.test(child.name)) continue;
            const type = child.name.replace(/^ac_/, '');
            if (NON_HOSTILE.test(type)) continue;

            const index = enemies.length;
            const id = CANONICAL_ID_BASE + index + 1;
            const x = Number((offset.x + child.x).toFixed(2));
            const y = Number((offset.y + child.y).toFixed(2));
            const carried = previousByKey.get(`${type}|${Math.round(x)}`);
            const boss = type === BOSS_TYPE;

            const enemy = {
                id,
                canonicalId: id,
                spawnIndex: index,
                type,
                name: type,
                x,
                y,
                roomId,
                groupId: null,
                waveId: null,
                triggerId: null,
                level: null,
                requiredForClear: true,
                boss,
                miniboss: false,
                scripted: false,
                sourceRoom: `a_Room_JCMini2_0${roomId}`,
                sourceVar: carried ? carried.sourceVar || '' : '',
                sourceLine: carried ? carried.sourceLine || 0 : 0,
                sourceSymbolId: ROOM_SYMBOLS[roomId],
                sourceCharacterId: child.characterId,
                depth: child.depth
            };
            if (carried && carried.sayOnActivate) enemy.sayOnActivate = carried.sayOnActivate;
            if (boss) {
                enemy.displayName = BOSS_DISPLAY_NAME;
                enemy.roomBoss = true;
                enemy.isRoomBoss = true;
                enemy.roomBossName = BOSS_DISPLAY_NAME;
            }
            enemy.spawnKey =
                `levelsJC|the_east_wing|room:${roomId}|index:${index}|type:${type}|pos:${Math.round(x)}:${Math.round(y)}`;
            enemies.push(enemy);
        }
    }

    const registry = {
        levelId: 'levelsJC',
        levelName: 'JC_Mini2',
        dungeonName: 'The East Wing',
        source: {
            swf: 'src/client/content/localhost/p/cbp/LevelsJC.swf',
            levelClass: LEVEL_CHARACTER,
            roomClasses: Object.keys(ROOM_SYMBOLS).map((roomId) => `a_Room_JCMini2_0${roomId}`),
            extractor: 'src/server/tools/exportEastWingEnemiesFromDisplayList.js'
        },
        generatedFromScript: true,
        coordinates: 'absolute world pixels from SWF room placement MATRIX plus placed instance MATRIX (full display list, includes unnamed instances)',
        canonicalIdBase: CANONICAL_ID_BASE,
        enemies
    };

    const perRoom = enemies.reduce((acc, enemy) => {
        acc[enemy.roomId] = (acc[enemy.roomId] || 0) + 1;
        return acc;
    }, {});
    console.log(`[EastWingExport] hostiles=${enemies.length} perRoom=${JSON.stringify(perRoom)} boss=${enemies.filter((e) => e.boss).map((e) => `${e.id}:${e.type}`).join(',')}`);

    if (dryRun) {
        console.log('[EastWingExport] --dry-run, not writing');
        return;
    }
    fs.writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(`[EastWingExport] wrote ${outputPath}`);
}

main();
