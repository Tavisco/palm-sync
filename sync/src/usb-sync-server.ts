import {MemoRecord} from '@palmira/pdb';
import {
  bitfield,
  field,
  SArray,
  SBitmask,
  SObject,
  SString,
  SUInt16LE,
  SUInt8,
} from 'serio';
import {Duplex, DuplexOptions} from 'stream';
import {WebUSB} from 'usb';
import {
  DlpCloseDBRequest,
  DlpOpenConduitRequest,
  DlpOpenDBRequest,
  DlpOpenMode,
  DlpReadDBListMode,
  DlpReadDBListRequest,
  DlpReadOpenDBInfoRequest,
  DlpReadRecordByIDRequest,
  DlpReadRecordIDListRequest,
  toUsbId,
  UsbDeviceConfig,
  UsbInitType,
  USB_DEVICE_CONFIGS_BY_ID,
} from '.';
import {NetSyncConnection} from './network-sync-server';
import {SyncConnection} from './sync-server';

/** Vendor USB control requests supported by Palm OS devices. */
export enum UsbControlRequestType {
  /** Query for the number of bytes that are available to be transferred to the
   * host for the specified endpoint. Currently not used, and always returns
   * 0x0001. */
  GET_NUM_BYTES_AVAILABLE = 0x01,
  /** Sent by the host to notify the device that the host is closing a pipe. An
   * empty packet is sent in response. */
  CLOSE_NOTIFICATION = 0x02,
  /** Sent by the host during enumeration to get endpoint information.
   *
   * Response type is GetConnectionInfoResponse.
   */
  GET_CONNECTION_INFO = 0x03,
  /** Sent by the host during enumeration to get entpoint information on newer devices.
   *
   * Respones type is GetExtConnectionInfoResponse.
   */
  GET_EXT_CONNECTION_INFO = 0x04,
}

/** Response type for GET_EXT_CONNECTION_INFO control requests. */
export class GetExtConnectionInfoResponse extends SObject {
  /** Number of ports in use (max 2).*/
  @field.as(SUInt8)
  numPorts = 0;
  /** Whether in and out endpoint numbers are different.
   *
   * If 0, the `portNumber` field specifies the in and out endpoint numbers, and
   * the `endpoints` field is zero.
   *
   * If 1, the `portNumber` field is zero, and the `endpoints` field
   * specifies the in and out endpoint numbers.
   */
  @field.as(SUInt8)
  hasDifferentEndpoints = 0;

  @field.as(SUInt16LE)
  private padding1 = 0;

  /** Port information. */
  @field.as(SArray)
  ports = Array(2)
    .fill(null)
    .map(() => new ExtConnectionPortInfo());
}

/** Information abount a port in a GetExtConnectionInfoResponse. */
export class ExtConnectionPortInfo extends SObject {
  /** Creator ID of the application that opened	this connection. */
  @field.as(SString.ofLength(4))
  type = 'AAAA';
  /** Specifies the in and out endpoint number if `hasDifferentEndpoints`
   * is 0, otherwise 0.  */
  @field.as(SUInt8)
  portNumber = 0;
  /** Specifies the in and out endpoint numbers if `hasDifferentEndpoints`
   * is 1, otherwise set to 0. */
  @field
  endpoints = new ExtConnectionEndpoints();

  @field.as(SUInt16LE)
  private padding1 = 0;
}

/** A pair of 4-bit endpoint numbers. */
export class ExtConnectionEndpoints extends SBitmask.as(SUInt8) {
  /** In endpoint number. */
  @bitfield(4)
  inEndpoint = 0;
  /** Out endpoint number. */
  @bitfield(4)
  outEndpoint = 0;
}

/** Response type for GET_CONNECTION_INFO control requests. */
export class GetConnectionInfoResponse extends SObject {
  /** Number of ports in use (max 2).*/
  @field.as(SUInt16LE)
  numPorts = 0;
  /** Port information. */
  @field.as(SArray)
  ports = Array(2)
    .fill(null)
    .map(() => new ConnectionPortInfo());
}

/** Port function types in GetConnectionInfoResponse. */
export enum ConnectionPortFunctionType {
  GENERIC = 0x00,
  DEBUGGER = 0x01,
  HOTSYNC = 0x02,
  CONSOLE = 0x03,
  REMOTE_FS = 0x04,
}

/** Information about a port in GetConnectionInfoResponse. */
export class ConnectionPortInfo extends SObject {
  @field.as(SUInt8.asEnum(ConnectionPortFunctionType))
  functionType = ConnectionPortFunctionType.GENERIC;
  @field.as(SUInt8)
  portNumber = 0;
}

/** Wait for a supported USB device. */
export async function waitForDevice() {
  const webusb = new WebUSB({allowAllDevices: true});
  for (;;) {
    const devices = await webusb.getDevices();
    let matchedDevice: USBDevice | null = null;
    let matchedDeviceConfig: UsbDeviceConfig | null = null;
    for (const device of devices) {
      const usbId = toUsbId(device);
      if (usbId in USB_DEVICE_CONFIGS_BY_ID) {
        matchedDevice = device;
        matchedDeviceConfig = USB_DEVICE_CONFIGS_BY_ID[usbId];
        break;
      }
    }
    if (matchedDevice && matchedDeviceConfig) {
      return {device: matchedDevice, deviceConfig: matchedDeviceConfig};
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Configuration for a USB connection, returned from USB device initialization
 * routines. */
export interface UsbConnectionConfig {
  /** The associated device. */
  device: USBDevice;
  /** Interrupt endpoint number. */
  interruptEndpoint: number;
  /** In endpoint number. */
  inEndpoint: number;
  /** Out endpoint number. */
  outEndpoint: number;
}

/** USB device initialization routines. */
export const USB_INIT_FNS: {
  [key in UsbInitType]: (device: USBDevice) => Promise<UsbConnectionConfig>;
} = {
  [UsbInitType.NONE]: async (device: USBDevice) => {
    return {
      device,
      interruptEndpoint: 0,
      inEndpoint: 0,
      outEndpoint: 0,
    };
  },
  [UsbInitType.GENERIC]: async (device: USBDevice) => {
    const config = {
      device,
      interruptEndpoint: 0,
      inEndpoint: 0,
      outEndpoint: 0,
    };

    console.log(`GetConnectionInfo`);
    const getConnectionInfoResponse = new GetConnectionInfoResponse();
    const result1 = await device.controlTransferIn(
      {
        requestType: 'vendor',
        recipient: 'endpoint',
        request: UsbControlRequestType.GET_CONNECTION_INFO,
        index: 0,
        value: 0,
      },
      getConnectionInfoResponse.getSerializedLength()
    );
    if (result1.status !== 'ok') {
      throw new Error(`GetConnectionInfo failed with status ${result1.status}`);
    }
    getConnectionInfoResponse.deserialize(Buffer.from(result1.data!.buffer));
    console.log(JSON.stringify(getConnectionInfoResponse, null, 2));
    const portInfo = getConnectionInfoResponse.ports
      .slice(0, getConnectionInfoResponse.numPorts)
      .find(
        ({functionType}) => functionType === ConnectionPortFunctionType.HOTSYNC
      );
    if (!portInfo) {
      throw new Error(
        `Could not identify HotSync port in GetConnectionInfo response: ` +
          JSON.stringify(getConnectionInfoResponse)
      );
    }
    config.interruptEndpoint = 0;
    config.inEndpoint = portInfo.portNumber;
    config.outEndpoint = portInfo.portNumber;

    /*
    const getExtConnectionInfoResponse = new GetExtConnectionInfoResponse();
    const result2 = await device.controlTransferIn(
      {
        requestType: 'vendor',
        recipient: 'endpoint',
        request: UsbControlRequestType.GET_EXT_CONNECTION_INFO,
        index: 0,
        value: 0,
      },
      getExtConnectionInfoResponse.getSerializedLength()
    );
    if (result2.status !== 'ok') {
      throw new Error(
        `GetExtConnectionInfo failed with status ${result2.status}`
      );
    }
    if (!result2.data) {
      throw new Error(`GetExtConnectionInfo returned no data`);
    }
    getExtConnectionInfoResponse.deserialize(Buffer.from(result2.data.buffer));
    console.log(JSON.stringify(getExtConnectionInfoResponse, null, 2));
    */

    // Query the number of bytes available. We ignore the response because 1) it
    // is broken and 2) we don't actually need it, but devices may expect this
    // call before sending data.
    console.log('GetNumBytesAvailable');
    const result3 = await device.controlTransferIn(
      {
        requestType: 'vendor',
        recipient: 'endpoint',
        request: UsbControlRequestType.GET_NUM_BYTES_AVAILABLE,
        index: 0,
        value: 0,
      },
      2
    );
    if (result3.status !== 'ok') {
      throw new Error(
        `GET_NUM_BYTES_AVAILABLE failed with status ${result3.status}`
      );
    }
    if (!result3.data) {
      throw new Error(`GET_NUM_BYTES_AVAILABLE returned no data`);
    }
    console.log(SUInt16LE.from(Buffer.from(result3.data.buffer)).value);

    return config;
  },
  [UsbInitType.VISOR]: async (device: USBDevice) => {
    return {
      device,
      interruptEndpoint: 0,
      inEndpoint: 0,
      outEndpoint: 0,
    };
  },
  [UsbInitType.SONY_CLIE]: async (device: USBDevice) => {
    return {
      device,
      interruptEndpoint: 0,
      inEndpoint: 0,
      outEndpoint: 0,
    };
  },
  [UsbInitType.TAPWAVE]: async (device: USBDevice) => {
    return {
      device,
      interruptEndpoint: 0,
      inEndpoint: 0,
      outEndpoint: 0,
    };
  },
};

/** Duplex stream for HotSync with an initialized USB device. */
export class UsbConnectionStream extends Duplex {
  constructor(
    /** Connection configuration. */
    private readonly config: UsbConnectionConfig,
    opts?: DuplexOptions
  ) {
    super(opts);
  }

  async _write(
    chunk: any,
    encoding: BufferEncoding | 'buffer',
    callback: (error?: Error | null) => void
  ) {
    if (encoding !== 'buffer' || !(chunk instanceof Buffer)) {
      callback(new Error(`Unsupported encoding ${encoding}`));
      return;
    }
    const result = await this.config.device.transferOut(
      this.config.outEndpoint,
      chunk
    );
    if (result.status === 'ok') {
      callback(null);
    } else {
      callback(new Error(`USB write failed with status ${result.status}`));
    }
  }

  async _read(size: number) {
    const result = await this.config.device.transferIn(
      this.config.inEndpoint,
      size
    );
    if (result.status === 'ok') {
      this.push(
        result.data ? Buffer.from(result.data.buffer) : Buffer.alloc(0)
      );
    } else {
      this.destroy(new Error(`USB read failed with status ${result.status}`));
    }
  }
}

if (require.main === module) {
  (async () => {
    console.log('Start');
    const {deviceConfig, device} = await waitForDevice();
    console.log(`Found config: ${JSON.stringify(deviceConfig, null, 2)}`);
    await device.open();
    // await device.selectConfiguration(1);
    // await device.claimInterface(0);
    const initFn = USB_INIT_FNS[deviceConfig.initType];
    const config = await initFn(device);
    console.log(JSON.stringify({...config, device: undefined}, null, 2));

    const usbConnectionStream = new UsbConnectionStream(config);
    const connection = new NetSyncConnection(usbConnectionStream);
    await connection.doHandshake();
    await connection.start();

    await (async ({dlpConnection}: SyncConnection) => {
      const readDbListResp = await dlpConnection.execute(
        DlpReadDBListRequest.with({
          mode: DlpReadDBListMode.LIST_RAM | DlpReadDBListMode.LIST_MULTIPLE,
        })
      );
      console.log(readDbListResp.metadataList.map(({name}) => name).join('\n'));

      /*
      await dlpConnection.execute(new DlpOpenConduitRequest());
      const {dbHandle} = await dlpConnection.execute(
        DlpOpenDBRequest.with({
          mode: DlpOpenMode.READ,
          name: 'MemoDB',
        })
      );
      const {numRecords} = await dlpConnection.execute(
        DlpReadOpenDBInfoRequest.with({dbHandle})
      );
      const {recordIds} = await dlpConnection.execute(
        DlpReadRecordIDListRequest.with({
          dbHandle,
          maxNumRecords: 500,
        })
      );
      const memoRecords: Array<MemoRecord> = [];
      for (const recordId of recordIds) {
        const resp = await dlpConnection.execute(
          DlpReadRecordByIDRequest.with({
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

      await dlpConnection.execute(DlpCloseDBRequest.with({dbHandle}));
      */
    })(connection);
    await connection.end();

    console.log('End');
  })();
}