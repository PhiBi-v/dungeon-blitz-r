/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

// Reported from a live two-player run: two party members walk through the same
// dungeon door a second apart and land in the dungeon unable to see each other --
// on both screens, for the rest of the run.
//
// Cause: a transferring player looks for a party member to inherit the dungeon
// instance from, and there are exactly two places one can be found -- an active
// session already standing in the dungeon, or a pending transfer entry for a
// player on their way there. Neither covers the middle of the trip. The pending
// entry is deleted the moment the destination client logs in to the game server
// (handleGameServerLogin), but `playerSpawned` does not flip until that client has
// finished downloading and loading the level SWF and sent its first entity update
// -- seconds later for a dungeon.
//
// A party member walking through the door inside that hole resolved no anchor at
// all and allocated their own instance. The level scope key is
// `levelName#levelInstanceId`, so two instances are two entity maps: neither
// player is ever sent the other, in either direction.
const DUNGEON_LEVEL = 'AC_Mission1';
const TOWN_LEVEL = 'Castle';
const PARTY_ID = 8101;
const SHARED_INSTANCE_ID = '37629';

type FakeClient = {
    userId: number;
    token: number;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    entryLevel: string;
    entryX: number;
    entryY: number;
    entryHasCoord: boolean;
    currentRoomId: number;
    syncAnchorStartedAt: number;
    syncAnchorToken: number;
    syncAnchorCharacterName: string;
    playerSpawned: boolean;
    clientEntID: number;
    entities: Map<number, any>;
    startedRoomEvents: Set<string>;
    sentPackets: { id: number; payload: Buffer }[];
    socket?: { destroyed?: boolean; readyState?: string };
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function createCharacter(name: string): any {
    return {
        name,
        class: 'rogue',
        gender: 'male',
        level: 50,
        xp: 0,
        gold: 0,
        CurrentLevel: { name: TOWN_LEVEL, x: 1000, y: 1000 },
        PreviousLevel: { name: TOWN_LEVEL, x: 1000, y: 1000 },
        equippedGears: [],
        inventoryGears: [],
        materials: {},
        consumables: [],
        charms: [],
        dyes: [],
        magicForge: {},
        missions: {},
        questTrackerState: 0
    };
}

function createFakeClient(name: string, token: number, userId: number): FakeClient {
    const character = createCharacter(name);
    const sentPackets: { id: number; payload: Buffer }[] = [];
    return {
        userId,
        token,
        character,
        characters: [character],
        currentLevel: TOWN_LEVEL,
        levelInstanceId: '',
        entryLevel: TOWN_LEVEL,
        entryX: 1000,
        entryY: 1000,
        entryHasCoord: true,
        currentRoomId: 0,
        syncAnchorStartedAt: 0,
        syncAnchorToken: 0,
        syncAnchorCharacterName: '',
        playerSpawned: true,
        clientEntID: token,
        entities: new Map<number, any>(),
        startedRoomEvents: new Set<string>(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

/**
 * A party member whose game-server session is bound to the dungeon but whose
 * client is still loading it: logged in, so the pending transfer entry is gone,
 * but no body in the level yet.
 */
function makeLoadingDungeonMember(name: string, token: number, userId: number): FakeClient {
    const member = createFakeClient(name, token, userId);
    member.currentLevel = DUNGEON_LEVEL;
    member.levelInstanceId = SHARED_INSTANCE_ID;
    member.syncAnchorStartedAt = 1;
    member.syncAnchorToken = token;
    member.syncAnchorCharacterName = name;
    member.playerSpawned = false;
    member.clientEntID = 0;
    member.entities.clear();
    return member;
}

function joinParty(...clients: FakeClient[]): void {
    GlobalState.partyGroups.set(PARTY_ID, {
        id: PARTY_ID,
        leader: clients[0].character.name,
        members: clients.map((client) => client.character.name),
        locked: false
    });
    for (const client of clients) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), PARTY_ID);
    }
}

function resetState(): void {
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.tokenChar.clear();
    GlobalState.usedTransferTokens.clear();
}

// The bug, on the door path: the second player walks in while the first is still
// loading, and must still land in the first player's instance.
function testDoorTransferSharesTheInstanceOfALoadingPartyMember(): void {
    const joiner = createFakeClient('AlexMercer', 21950, 21950);
    const loading = makeLoadingDungeonMember('Neodevils', 8084, 33485);

    GlobalState.sessionsByToken.set(loading.token, loading as never);
    joinParty(joiner, loading);

    const syncState = (LevelHandler as any).buildTransferSyncState(joiner, DUNGEON_LEVEL, null);

    assert.ok(syncState, 'walking into a dungeon behind a party member produced no sync state');
    assert.equal(
        syncState.levelInstanceId,
        SHARED_INSTANCE_ID,
        'a party member still loading the dungeon left the joiner in a private instance'
    );
    assert.equal(
        syncState.syncAnchorToken,
        loading.token,
        'the loading party member should still own the run'
    );
    assert.equal(
        syncState.syncAnchorCharacterName,
        loading.character.name,
        'the loading party member should still own the run identity'
    );
    // Sharing the instance is not the same as being placed on a body. Nobody has
    // reported standing anywhere in there yet, so there is no floor to arrive on
    // and the level's authored start has to win -- see core/GroundedPosition.
    assert.equal(
        syncState.hasCoord,
        false,
        'a party member with no confirmed standing position must not place the joiner'
    );
}

// The mirror case on the login path: reconnecting into a dungeon a party member is
// still loading into.
function testEnterWorldSharesTheInstanceOfALoadingPartyMember(): void {
    const joiner = createFakeClient('AlexMercer', 21950, 21950);
    const loading = makeLoadingDungeonMember('Neodevils', 8084, 33485);
    joiner.currentLevel = DUNGEON_LEVEL;
    joiner.character.CurrentLevel = { name: DUNGEON_LEVEL, x: 1000, y: 1000 };
    // Without a snapshot the saved dungeon location is treated as unsafe and repaired
    // back out to the entry level, and the login never targets the dungeon at all.
    joiner.character.DungeonSnapshot = {
        levelName: DUNGEON_LEVEL,
        x: 1000,
        y: 1000,
        hasCoord: true,
        entryLevel: TOWN_LEVEL,
        entryX: 1000,
        entryY: 1000,
        entryHasCoord: true,
        currentRoomId: 1,
        startedRoomIds: [1],
        savedAt: Date.now()
    };

    GlobalState.sessionsByToken.set(loading.token, loading as never);
    joinParty(joiner, loading);

    (CharacterHandler as any).sendEnterWorld(joiner, joiner.character);

    const pendingTokens = Array.from(GlobalState.pendingWorld.keys());
    assert.equal(pendingTokens.length, 1, 'sendEnterWorld should create exactly one pending token');
    const pendingEntry = GlobalState.pendingWorld.get(pendingTokens[0]);
    assert.ok(pendingEntry, 'sendEnterWorld should store a pending world entry');
    assert.equal(
        pendingEntry.levelInstanceId,
        SHARED_INSTANCE_ID,
        'logging in while a party member loads the same dungeon opened a second instance'
    );
    assert.equal(
        pendingEntry.syncAnchorToken,
        loading.token,
        'the loading party member should still own the run through the login path'
    );
}

// clearTransferState drops playerSpawned but leaves currentLevel pointing at the
// level being left, so a departing player looks a lot like an arriving one. They
// carry no instance binding, and they must not anchor anybody: the run they were
// in is not the run the joiner is starting.
function testDepartingPartyMemberDoesNotAnchorAFreshRun(): void {
    const joiner = createFakeClient('AlexMercer', 21950, 21950);
    const departing = createFakeClient('Neodevils', 8084, 33485);
    departing.currentLevel = DUNGEON_LEVEL;
    departing.levelInstanceId = '';
    departing.playerSpawned = false;
    departing.clientEntID = 0;
    departing.syncAnchorStartedAt = 0;
    departing.syncAnchorToken = 0;
    departing.syncAnchorCharacterName = '';

    GlobalState.sessionsByToken.set(departing.token, departing as never);
    joinParty(joiner, departing);

    const syncState = (LevelHandler as any).buildTransferSyncState(joiner, DUNGEON_LEVEL, null);

    assert.equal(
        syncState?.levelInstanceId ?? undefined,
        undefined,
        'a party member walking out of the dungeon anchored a run they are not in'
    );
    assert.equal(
        syncState?.syncAnchorToken ?? undefined,
        undefined,
        'a departing party member must not be recorded as the run owner'
    );
}

// A member standing in the dungeon still wins the arrival position over one that
// is merely loading, so joining a run in progress does not get worse.
function testStandingMemberStillSuppliesTheArrivalPosition(): void {
    const joiner = createFakeClient('AlexMercer', 21950, 21950);
    const loading = makeLoadingDungeonMember('Neodevils', 8084, 33485);
    const standing = createFakeClient('ClosedFriend', 4444, 99881);
    standing.currentLevel = DUNGEON_LEVEL;
    standing.levelInstanceId = SHARED_INSTANCE_ID;
    standing.syncAnchorStartedAt = 2;
    standing.syncAnchorToken = standing.token;
    standing.syncAnchorCharacterName = standing.character.name;
    standing.entities.set(standing.clientEntID, {
        id: standing.clientEntID,
        isPlayer: true,
        x: 400,
        y: 500,
        groundedX: 400,
        groundedY: 500,
        groundedLevel: DUNGEON_LEVEL,
        groundedAbsolute: true
    });

    GlobalState.sessionsByToken.set(loading.token, loading as never);
    GlobalState.sessionsByToken.set(standing.token, standing as never);
    joinParty(joiner, loading, standing);

    const syncState = (LevelHandler as any).buildTransferSyncState(joiner, DUNGEON_LEVEL, null);

    assert.ok(syncState, 'joining a live party dungeon produced no sync state');
    assert.equal(syncState.levelInstanceId, SHARED_INSTANCE_ID, 'the joiner left the shared instance');
    assert.equal(syncState.hasCoord, true, 'the joiner was sent to the dungeon entrance instead of the party');
    assert.equal(syncState.x, 400, 'the joiner should arrive on the standing party member');
    assert.equal(syncState.y, 500, 'the joiner should arrive on the standing party member');
    assert.equal(
        syncState.syncAnchorCharacterName,
        loading.character.name,
        'borrowing a position must not reassign the run anchor'
    );
}

function run(): void {
    const pendingWorld = new Map(GlobalState.pendingWorld);
    const pendingExtended = new Map(GlobalState.pendingExtended);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const sessionsByCharacterName = new Map(GlobalState.sessionsByCharacterName);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const tokenChar = new Map(GlobalState.tokenChar);
    const usedTransferTokens = new Map(GlobalState.usedTransferTokens);

    if (!LevelConfig.has(DUNGEON_LEVEL)) {
        LevelConfig.load(path.join(__dirname, '..', 'data'));
    }
    assert.equal(LevelConfig.isDungeonLevel(DUNGEON_LEVEL), true, `${DUNGEON_LEVEL} is not a dungeon level`);

    try {
        resetState();
        testDoorTransferSharesTheInstanceOfALoadingPartyMember();
        resetState();
        testEnterWorldSharesTheInstanceOfALoadingPartyMember();
        resetState();
        testDepartingPartyMemberDoesNotAnchorAFreshRun();
        resetState();
        testStandingMemberStillSuppliesTheArrivalPosition();
        console.log('party loading member scope regression passed');
    } finally {
        GlobalState.pendingWorld = pendingWorld;
        GlobalState.pendingExtended = pendingExtended;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.sessionsByCharacterName = sessionsByCharacterName;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
        GlobalState.tokenChar = tokenChar;
        GlobalState.usedTransferTokens = usedTransferTokens;
    }
}

run();
