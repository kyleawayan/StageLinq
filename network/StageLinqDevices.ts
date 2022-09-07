import { ConnectionInfo, IpAddress, PlayerStatus, ServiceMessage } from '../types';
import { EventEmitter } from 'events';
import { NetworkDevice } from '.';
import { Player } from '../devices/Player';
import { sleep } from '../utils';
import { StateData, StateMap } from '../services';
import { Logger } from '../LogEmitter';
import { Db } from '../db';

enum ConnectionStatus { CONNECTING, CONNECTED, FAILED };

interface StageLinqDevice {
  networkDevice: NetworkDevice;
};

interface StageLinqDeviceOptions {
  maxRetries?: number;
  getMetdataFromFile?: boolean;
}

export declare interface StageLinqDevices {
  on(event: 'trackLoaded', listener: (status: PlayerStatus) => void): this;
  on(event: 'stateChanged', listener: (status: PlayerStatus) => void): this;
  on(event: 'nowPlaying', listener: (status: PlayerStatus) => void): this;
  on(event: 'connected', listener: (connectionInfo: ConnectionInfo) => void): this;
  on(event: 'message', listener: (connectionInfo: ConnectionInfo, message: ServiceMessage<StateData>) => void): this;
}

const DEFAULT_MAX_RETRIES = 3;

//////////////////////////////////////////////////////////////////////////////

// TODO: Refactor device, listener, and player into something more nicer.

/**
 * Handle connecting and disconnecting from discovered devices on the
 * StageLinq network.
 */
export class StageLinqDevices extends EventEmitter {

  private devices: Map<IpAddress, StageLinqDevice> = new Map();
  private discoveryStatus: Map<string, ConnectionStatus> = new Map();
  private options: StageLinqDeviceOptions;

  constructor(options?: StageLinqDeviceOptions) {
    super();
    this.options = {
      maxRetries: DEFAULT_MAX_RETRIES,
      getMetdataFromFile: false,
      ...options
    };
  }

  /**
   * Attempt to connect to the player.
   *
   * @param connectionInfo Device discovered
   * @returns Retries to connect 3 times. If successful return void if not throw exception.
   */
  async handleDevice(connectionInfo: ConnectionInfo) {
    Logger.silly(this.showDiscoveryStatus(connectionInfo));

    // Ignore this discovery message if connected, connecting, failed, or
    // if it's blacklisted.
    if (this.isConnected(connectionInfo)
      || this.isConnecting(connectionInfo)
      || this.isFailed(connectionInfo)
      || this.isIgnored(connectionInfo)) return;

    this.discoveryStatus.set(this.deviceId(connectionInfo), ConnectionStatus.CONNECTING);

    // Retrying appears to be necessary because it seems the Denon hardware
    // sometimes doesn't connect. Retrying after a little wait seems to
    // solve the issue.
  
    let attempt = 1;

    while (attempt < this.options.maxRetries) {
      try {
        Logger.info(`Connecting to ${this.deviceId(connectionInfo)}. ` +
          `Attempt ${attempt}/${this.options.maxRetries}`);

        // If this fails, catch it, and maybe retry if necessary.
        await this.connectToPlayer(connectionInfo);

        Logger.info(`Successfully connected to ${this.deviceId(connectionInfo)}`);
        this.discoveryStatus.set(this.deviceId(connectionInfo), ConnectionStatus.CONNECTED);
        this.emit('connected', connectionInfo);

        return; // Don't forget to return!

      } catch(e) {

        // Failed connection. Sleep then retry.
        Logger.warn(`Could not connect to ${this.deviceId(connectionInfo)} ` +
          `(${attempt}/${this.options.maxRetries}): ${e}`);
        attempt += 1;
        sleep(500);

      }
    }

    // We failed 3 times. Throw exception.
    this.discoveryStatus.set(this.deviceId(connectionInfo), ConnectionStatus.FAILED);
    throw new Error(`Could not connect to ${this.deviceId(connectionInfo)}`);
  }

  /**
   * Disconnect from all connected devices
   */
  disconnectAll() {
    for (const device of this.devices.values()) {
      device.networkDevice.disconnect();
    }
  }

  ////////////////////////////////////////////////////////////////////////////

  /**
   * Connect to the player.
   * @param connectionInfo Device to connect to.
   * @returns
   */
  private async connectToPlayer(connectionInfo: ConnectionInfo) {
    const networkDevice = new NetworkDevice(connectionInfo);
    await networkDevice.connect();

    // Track devices so we can disconnect from them later.
    this.devices.set(connectionInfo.address, { networkDevice: networkDevice });

    // Download the database before connecting to StateMap.
    const database = new Db(networkDevice);
    await database.downloadDb();

    // Setup StateMap
    const stateMap = await networkDevice.connectToService(StateMap);
    stateMap.on('message', (data) => {
      this.emit('message', connectionInfo, data)
    });

    // Setup Player
    const player = new Player({
      stateMap: stateMap,
      address: connectionInfo.address,
      port: connectionInfo.port
    });
    player.on('trackLoaded', (status) => {
      this.emit('trackLoaded', status);
      // TODO: SELECT * FROM Tracks WHERE path = status.trackPath
    });
    player.on('stateChanged', (status) => {
      this.emit('stateChanged', status);
    });
    player.on('nowPlaying', (status) => {
      this.emit('nowPlaying', status);
    });

  }

  private deviceId(device: ConnectionInfo) {
    return `${device.address}:${device.port}:` +
      `[${device.source}/${device.software.name}]`;
  }

  private isConnecting(device: ConnectionInfo) {
    return this.discoveryStatus.get(this.deviceId(device))
      === ConnectionStatus.CONNECTING;
  }

  private isConnected(device: ConnectionInfo) {
    return this.discoveryStatus.get(this.deviceId(device))
      === ConnectionStatus.CONNECTED;
  }

  private isFailed(device: ConnectionInfo) {
    return this.discoveryStatus.get(this.deviceId(device))
      === ConnectionStatus.FAILED;
  }

  private isIgnored(device: ConnectionInfo) {
    return (
      device.software.name === 'OfflineAnalyzer'
      || device.source === 'nowplaying' // Ignore myself
      || /^SoundSwitch/i.test(device.software.name)
      || /^Resolume/i.test(device.software.name)
      || device.software.name === 'JM08' // Ignore X1800/X1850 mixers
      || device.software.name === 'SSS0' // Ignore SoundSwitchEmbedded on players
    )
  }

  private isDeviceSeen(device: ConnectionInfo) {
    return this.discoveryStatus.has(device.address);
  }

  private showDiscoveryStatus(device: ConnectionInfo) {
    let msg = `Discovery: ${this.deviceId(device)} `;

    if (!this.isDeviceSeen) return msg += '(NEW)';
    if (this.isIgnored(device)) return msg += '(IGNORED)';
    return msg += (
      this.isConnecting(device) ? '(CONNECTING)'
      : this.isConnected(device) ? '(CONNECTED)'
      : this.isFailed(device) ? '(FAILED)'
      : '(NEW)');
  }

}