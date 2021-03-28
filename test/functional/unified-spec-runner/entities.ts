import {
  MongoClient,
  Db,
  Collection,
  GridFSBucket,
  Document,
  HostAddress
} from '../../../src/index';
import { ReadConcern } from '../../../src/read_concern';
import { WriteConcern } from '../../../src/write_concern';
import { ReadPreference } from '../../../src/read_preference';
import { ClientSession } from '../../../src/sessions';
import { ChangeStream } from '../../../src/change_stream';
import type { ClientEntity, EntityDescription } from './schema';
import type {
  CommandFailedEvent,
  CommandStartedEvent,
  CommandSucceededEvent
} from '../../../src/cmap/events';
import { patchCollectionOptions, patchDbOptions } from './unified-utils';
import { expect } from 'chai';
import { TestConfiguration } from './runner';

interface UnifiedChangeStream extends ChangeStream {
  eventCollector: InstanceType<typeof import('../../tools/utils')['EventCollector']>;
}

export type CommandEvent = CommandStartedEvent | CommandSucceededEvent | CommandFailedEvent;

function serverApiConfig() {
  if (process.env.MONGODB_API_VERSION) {
    return { version: process.env.MONGODB_API_VERSION };
  }
}

function getClient(address) {
  const serverApi = serverApiConfig();
  return new MongoClient(`mongodb://${address}`, serverApi ? { serverApi } : {});
}

export class UnifiedMongoClient extends MongoClient {
  events: CommandEvent[];
  failPoints: Document[];
  ignoredEvents: string[];
  observedEvents: ('commandStarted' | 'commandSucceeded' | 'commandFailed')[];

  static EVENT_NAME_LOOKUP = {
    commandStartedEvent: 'commandStarted',
    commandSucceededEvent: 'commandSucceeded',
    commandFailedEvent: 'commandFailed'
  } as const;

  constructor(url: string, description: ClientEntity) {
    super(url, {
      monitorCommands: true,
      ...description.uriOptions,
      serverApi: description.serverApi ? description.serverApi : serverApiConfig()
    });
    this.events = [];
    this.failPoints = [];
    this.ignoredEvents = [
      ...(description.ignoreCommandMonitoringEvents ?? []),
      'configureFailPoint'
    ];
    // apm
    this.observedEvents = (description.observeEvents ?? []).map(
      e => UnifiedMongoClient.EVENT_NAME_LOOKUP[e]
    );
    for (const eventName of this.observedEvents) {
      this.on(eventName, this.pushEvent);
    }
  }

  // NOTE: pushEvent must be an arrow function
  pushEvent: (e: CommandEvent) => void = e => {
    if (!this.ignoredEvents.includes(e.commandName)) {
      this.events.push(e);
    }
  };

  /** Disables command monitoring for the client and returns a list of the captured events. */
  stopCapturingEvents(): CommandEvent[] {
    for (const eventName of this.observedEvents) {
      this.off(eventName, this.pushEvent);
    }
    return this.events;
  }
}

export class FailPointMap extends Map<string, Document> {
  async enableFailPoint(
    addressOrClient: HostAddress | UnifiedMongoClient,
    failPoint: Document
  ): Promise<Document> {
    let client: MongoClient;
    let address: string;
    if (addressOrClient instanceof MongoClient) {
      client = addressOrClient;
      address = client.topology.s.seedlist.join(',');
    } else {
      // create a new client
      address = addressOrClient.toString();
      client = getClient(address);
      await client.connect();
    }

    const admin = client.db('admin');
    const result = await admin.command(failPoint);

    if (!(addressOrClient instanceof MongoClient)) {
      // we created this client
      await client.close();
    }

    expect(result).to.have.property('ok', 1);
    this.set(address, failPoint.configureFailPoint);
    return result;
  }

  async disableFailPoints(): Promise<void> {
    const entries = Array.from(this.entries());
    await Promise.all(
      entries.map(async ([hostAddress, configureFailPoint]) => {
        const client = getClient(hostAddress);
        await client.connect();
        const admin = client.db('admin');
        const result = await admin.command({ configureFailPoint, mode: 'off' });
        expect(result).to.have.property('ok', 1);
        await client.close();
      })
    );
  }
}

export type Entity =
  | UnifiedMongoClient
  | Db
  | Collection
  | ClientSession
  | UnifiedChangeStream
  | GridFSBucket
  | Document; // Results from operations

export type EntityCtor =
  | typeof UnifiedMongoClient
  | typeof Db
  | typeof Collection
  | typeof ClientSession
  | typeof ChangeStream
  | typeof GridFSBucket;

export type EntityTypeId = 'client' | 'db' | 'collection' | 'session' | 'bucket' | 'stream';

const ENTITY_CTORS = new Map<EntityTypeId, EntityCtor>();
ENTITY_CTORS.set('client', UnifiedMongoClient);
ENTITY_CTORS.set('db', Db);
ENTITY_CTORS.set('collection', Collection);
ENTITY_CTORS.set('session', ClientSession);
ENTITY_CTORS.set('bucket', GridFSBucket);
ENTITY_CTORS.set('stream', ChangeStream);

export class EntitiesMap<E = Entity> extends Map<string, E> {
  failPoints: FailPointMap;

  constructor(entries?: readonly (readonly [string, E])[] | null) {
    super(entries);
    this.failPoints = new FailPointMap();
  }

  mapOf(type: 'client'): EntitiesMap<UnifiedMongoClient>;
  mapOf(type: 'db'): EntitiesMap<Db>;
  mapOf(type: 'collection'): EntitiesMap<Collection>;
  mapOf(type: 'session'): EntitiesMap<ClientSession>;
  mapOf(type: 'bucket'): EntitiesMap<GridFSBucket>;
  mapOf(type: 'stream'): EntitiesMap<UnifiedChangeStream>;
  mapOf(type: EntityTypeId): EntitiesMap<Entity> {
    const ctor = ENTITY_CTORS.get(type);
    if (!ctor) {
      throw new Error(`Unknown type ${type}`);
    }
    return new EntitiesMap(Array.from(this.entries()).filter(([, e]) => e instanceof ctor));
  }

  getEntity(type: 'client', key: string, assertExists?: boolean): UnifiedMongoClient;
  getEntity(type: 'db', key: string, assertExists?: boolean): Db;
  getEntity(type: 'collection', key: string, assertExists?: boolean): Collection;
  getEntity(type: 'session', key: string, assertExists?: boolean): ClientSession;
  getEntity(type: 'bucket', key: string, assertExists?: boolean): GridFSBucket;
  getEntity(type: 'stream', key: string, assertExists?: boolean): UnifiedChangeStream;
  getEntity(type: EntityTypeId, key: string, assertExists = true): Entity {
    const entity = this.get(key);
    if (!entity) {
      if (assertExists) throw new Error(`Entity '${key}' does not exist`);
      return;
    }
    const ctor = ENTITY_CTORS.get(type);
    if (!ctor) {
      throw new Error(`Unknown type ${type}`);
    }
    if (!(entity instanceof ctor)) {
      throw new Error(`${key} is not an instance of ${type}`);
    }
    return entity;
  }

  async cleanup(): Promise<void> {
    await this.failPoints.disableFailPoints();
    for (const [, client] of this.mapOf('client')) {
      await client.close();
    }
    for (const [, session] of this.mapOf('session')) {
      await session.endSession();
    }
    this.clear();
  }

  static async createEntities(
    config: TestConfiguration,
    entities?: EntityDescription[]
  ): Promise<EntitiesMap> {
    const map = new EntitiesMap();
    for (const entity of entities ?? []) {
      if ('client' in entity) {
        const useMultipleMongoses =
          config.topologyType === 'Sharded' && entity.client.useMultipleMongoses;
        const uri = config.url({ useMultipleMongoses });
        const client = new UnifiedMongoClient(uri, entity.client);
        await client.connect();
        map.set(entity.client.id, client);
      } else if ('database' in entity) {
        const client = map.getEntity('client', entity.database.client);
        const db = client.db(
          entity.database.databaseName,
          patchDbOptions(entity.database.databaseOptions)
        );
        map.set(entity.database.id, db);
      } else if ('collection' in entity) {
        const db = map.getEntity('db', entity.collection.database);
        const collection = db.collection(
          entity.collection.collectionName,
          patchCollectionOptions(entity.collection.collectionOptions)
        );
        map.set(entity.collection.id, collection);
      } else if ('session' in entity) {
        const client = map.getEntity('client', entity.session.client);

        const options = Object.create(null);

        if (entity.session.sessionOptions?.causalConsistency) {
          options.causalConsistency = entity.session.sessionOptions?.causalConsistency;
        }

        if (entity.session.sessionOptions?.defaultTransactionOptions) {
          options.defaultTransactionOptions = Object.create(null);
          const defaultOptions = entity.session.sessionOptions.defaultTransactionOptions;
          if (defaultOptions.readConcern) {
            options.defaultTransactionOptions.readConcern = ReadConcern.fromOptions(
              defaultOptions.readConcern
            );
          }
          if (defaultOptions.writeConcern) {
            options.defaultTransactionOptions.writeConcern = WriteConcern.fromOptions(
              defaultOptions
            );
          }
          if (defaultOptions.readPreference) {
            options.defaultTransactionOptions.readPreference = ReadPreference.fromOptions(
              defaultOptions.readPreference
            );
          }
          if (typeof defaultOptions.maxCommitTimeMS === 'number') {
            options.defaultTransactionOptions.maxCommitTimeMS = defaultOptions.maxCommitTimeMS;
          }
        }

        const session = client.startSession(options);
        map.set(entity.session.id, session);
      } else if ('bucket' in entity) {
        const db = map.getEntity('db', entity.bucket.database);

        const options = Object.create(null);

        if (entity.bucket.bucketOptions?.bucketName) {
          options.bucketName = entity.bucket.bucketOptions?.bucketName;
        }
        if (entity.bucket.bucketOptions?.chunkSizeBytes) {
          options.chunkSizeBytes = entity.bucket.bucketOptions?.chunkSizeBytes;
        }
        if (entity.bucket.bucketOptions?.readPreference) {
          options.readPreference = entity.bucket.bucketOptions?.readPreference;
        }

        map.set(entity.bucket.id, new GridFSBucket(db, options));
      } else if ('stream' in entity) {
        throw new Error(`Unsupported Entity ${JSON.stringify(entity)}`);
      } else {
        throw new Error(`Unsupported Entity ${JSON.stringify(entity)}`);
      }
    }
    return map;
  }
}
