import debug from 'debug';
import EventEmitter from 'events';
import pEvent from 'p-event';
import {MemoRecord} from 'palm-pdb';
import {SerialPort} from 'serialport';
import {Duplex} from 'stream';
import {doCmpHandshake} from './cmp-protocol';
import {
  DlpCloseDBReqType,
  DlpOpenConduitReqType,
  DlpOpenDBReqType,
  DlpOpenMode,
  DlpReadDBListMode,
  DlpReadDBListReqType,
  DlpReadOpenDBInfoReqType,
  DlpReadRecordIDListReqType,
  DlpReadRecordReqType,
} from './dlp-commands';
import {PadpStream} from './padp-protocol';
import {SyncConnection, SyncFn} from './sync-server';

/** Sync server using a serial port. */
export class SerialSyncServer extends EventEmitter {
  /** Serial port device to listen on. */
  device: string;
  /** SerialPort instance. */
  serialPort: SerialPort | null = null;

  constructor(device: string, syncFn: SyncFn) {
    super();
    this.device = device;
    this.syncFn = syncFn;
  }

  start() {
    if (this.serialPort) {
      throw new Error('Server already started');
    }
    this.serialPort = new SerialPort(
      {
        path: this.device,
        baudRate: 9600,
      },
      (error) => {
        if (error) {
          throw error;
        } else {
          this.run();
        }
      }
    );
  }

  async stop() {
    if (!this.serialPort) {
      return;
    }
    this.serialPort.close();
    await pEvent(this.serialPort, 'close');
    this.serialPort = null;
  }

  async onConnection(rawStream: Duplex) {
    const connection = new SerialSyncConnection(rawStream);
    this.emit('connect', connection);

    this.serialPort?.update({baudRate: 9600});
    this.log('Starting handshake');
    await connection.doHandshake();
    this.log('Handshake complete');
    this.serialPort?.update({baudRate: 115200});

    await connection.start();

    await this.syncFn(connection);

    await connection.end();
    this.emit('disconnect', connection);
  }

  private async run() {
    while (this.serialPort && this.serialPort.isOpen) {
      try {
        await this.onConnection(this.serialPort);
      } catch (e: any) {
        // Ignore
      }
    }
  }

  /** HotSync logic to run when a connection is made. */
  syncFn: SyncFn;
  /** Debugger. */
  private log = debug('palm-dlp').extend('serial');
}

export class SerialSyncConnection extends SyncConnection<PadpStream> {
  createDlpStream(rawStream: Duplex): PadpStream {
    return new PadpStream(rawStream);
  }
  async doHandshake(): Promise<void> {
    await doCmpHandshake(this.dlpStream, 115200);
  }
}

if (require.main === module) {
  const syncServer = new SerialSyncServer(
    '/dev/ttyS0',
    async ({dlpConnection}) => {
      const readDbListResp = await dlpConnection.execute(
        DlpReadDBListReqType.with({
          mode: DlpReadDBListMode.LIST_RAM | DlpReadDBListMode.LIST_MULTIPLE,
        })
      );
      console.log(readDbListResp.metadataList.map(({name}) => name).join('\n'));

      await dlpConnection.execute(new DlpOpenConduitReqType());
      const {dbHandle} = await dlpConnection.execute(
        DlpOpenDBReqType.with({
          mode: DlpOpenMode.READ,
          name: 'MemoDB',
        })
      );
      const {numRecords} = await dlpConnection.execute(
        DlpReadOpenDBInfoReqType.with({dbHandle})
      );
      const {recordIds} = await dlpConnection.execute(
        DlpReadRecordIDListReqType.with({
          dbHandle,
          maxNumRecords: 500,
        })
      );
      const memoRecords: Array<MemoRecord> = [];
      for (const recordId of recordIds) {
        const resp = await dlpConnection.execute(
          DlpReadRecordReqType.with({
            dbHandle,
            recordId,
          })
        );
        const record = MemoRecord.from(resp.data.value);
        memoRecords.push(record);
      }
      console.log(
        `Memos:\n----------\n${memoRecords
          .map(({value}) => value)
          .filter((value) => !!value.trim())
          .join('\n----------\n')}\n----------\n`
      );

      await dlpConnection.execute(DlpCloseDBReqType.with({dbHandle}));
    }
  );
  syncServer.start();
}
