"use strict";
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.riscoMqttHomeAssistant = void 0;
const merge_1 = __importDefault(require("lodash/merge"));
const mqtt_1 = __importDefault(require("mqtt"));
const dist_1 = require("@vanackej/risco-lan-bridge/dist");
const winston_1 = __importDefault(require("winston"));
const lodash_1 = require("lodash");
const { createLogger, format, transports } = winston_1.default;
const { combine, timestamp, printf, colorize } = format;
const ALARM_TOPIC = 'riscopanel/alarm';
const ALARM_TOPIC_REGEX = /^riscopanel\/alarm\/([0-9]+)\/set$/m;
const ZONE_BYPASS_TOPIC_REGEX = /^riscopanel\/alarm\/zone\/([0-9]+)-bypass\/set$/m;
const RISCO_NODE_ID = 'risco-alarm-panel';
const CONFIG_DEFAULTS = {
    log: 'info',
    logColorize: false,
    ha_discovery_prefix_topic: 'homeassistant',
    ha_discovery_include_nodeId: false,
    mqtt_alarm_topic: 'riscopanel/alarm',
    panel: {},
    zones: {
        default: {
            off_delay: 0,
            device_class: 'motion',
            name_prefix: '',
        },
    },
    mqtt: {
        url: null,
        reconnectPeriod: 5000,
        clientId: 'risco-mqtt-' + Math.random().toString(16).substring(2, 8),
    },
};
function riscoMqttHomeAssistant(userConfig) {
    var _a;
    const config = (0, merge_1.default)(CONFIG_DEFAULTS, userConfig);
    let format = combine(timestamp({
        format: () => new Date().toLocaleString(),
    }), printf(({ level, message, label, timestamp }) => {
        return `${timestamp} [${level}] ${message}`;
    }));
    if (config.logColorize) {
        format = combine(colorize({
            all: false,
            level: true,
        }), format);
    }
    const logger = createLogger({
        format: format,
        level: config.log || 'info',
        transports: [
            new transports.Console(),
        ],
    });
    logger.debug(`User config:\n${JSON.stringify(userConfig, null, 2)}`);
    logger.debug(`Merged config:\n${JSON.stringify(config, null, 2)}`);
    class WinstonRiscoLogger {
        log(log_lvl, log_data) {
            logger.log(log_lvl, log_data);
        }
    }
    config.panel.logger = new WinstonRiscoLogger();
    let panelReady = false;
    let mqttReady = false;
    let listenerInstalled = false;
    if (!((_a = config.mqtt) === null || _a === void 0 ? void 0 : _a.url))
        throw new Error('mqtt url options is required');
    const panel = new dist_1.RiscoPanel(config.panel);
    panel.on('SystemInitComplete', () => {
        panel.riscoComm.tcpSocket.on('Disconnected', () => {
            panelReady = false;
            publishOffline();
        });
        if (!panelReady) {
            panelReady = true;
            panelOrMqttConnected();
        }
    });
    logger.info(`Connecting to mqtt server: ${config.mqtt.url}`);
    const mqttClient = mqtt_1.default.connect(config.mqtt.url, config.mqtt.reconnectPeriod, config.mqtt.clientId, JSON.stringify({ will: {
        topic: `${config.mqtt_alarm_topic}/status`, payload: 'offline', qos: 1, retain: true, properties: {
            willDelayInterval: 30,
        },
    }}));
    mqttClient.on('connect', () => {
        logger.info(`Connected on mqtt server: ${config.mqtt.url}`);
        if (!mqttReady) {
            mqttReady = true;
            panelOrMqttConnected();
        }
    });
    mqttClient.on('reconnect', () => {
        logger.info('MQTT reconnect');
    });
    mqttClient.on('disconnect', () => {
        logger.info('MQTT disconnect');
        mqttReady = false;
    });
    mqttClient.on('close', () => {
        logger.info('MQTT close');
        mqttReady = false;
    });
    mqttClient.on('error', (error) => {
        logger.error(`MQTT connection error: ${error}`);
        mqttReady = false;
    });
    mqttClient.on('message', (topic, message) => {
        let m;
        if ((m = ALARM_TOPIC_REGEX.exec(topic)) !== null) {
            m.filter((match, groupIndex) => groupIndex !== 0).forEach((partitionId) => __awaiter(this, void 0, void 0, function* () {
                const command = message.toString();
                logger.info(`[MQTT => Panel] Received change state command ${command} on topic ${topic} in partition ${partitionId}`);
                try {
                    const success = yield changeAlarmStatus(command, partitionId);
                    if (success) {
                        logger.info(`[MQTT => Panel] ${command} command sent on partition ${partitionId}`);
                    }
                    else {
                        logger.error(`[MQTT => Panel] Failed to send ${command} command on partition ${partitionId}`);
                    }
                }
                catch (err) {
                    logger.error(`[MQTT => Panel] Error during state change command ${command} from topic ${topic} on partition ${partitionId}`);
                    logger.error(err);
                }
            }));
        }
        else if ((m = ZONE_BYPASS_TOPIC_REGEX.exec(topic)) !== null) {
            m.filter((match, groupIndex) => groupIndex !== 0).forEach((zoneId) => __awaiter(this, void 0, void 0, function* () {
                const bypass = parseInt(message.toString(), 10) == 1;
                logger.info(`[MQTT => Panel] Received bypass zone command ${bypass} on topic ${topic} for zone ${zoneId}`);
                try {
                    if (bypass !== panel.zones.byId(zoneId).Bypass) {
                        const success = yield panel.toggleBypassZone(zoneId);
                        if (success) {
                            logger.info(`[MQTT => Panel] toggle bypass command sent on zone ${zoneId}`);
                        }
                        else {
                            logger.error(`[MQTT => Panel] Failed to send toggle bypass command on zone ${zoneId}`);
                        }
                    }
                    else {
                        logger.info('[MQTT => Panel] Zone is already on the desired bypass state');
                    }
                }
                catch (err) {
                    logger.error(`[MQTT => Panel] Error during zone bypass toggle command from topic ${topic} on zone ${zoneId}`);
                    logger.error(err);
                }
            }));
        }
        else if (topic == `${config.ha_discovery_prefix_topic}/status`) {
            if (message.toString() === 'online') {
                logger.info('Home Assistant is back online');
                panelOrMqttConnected();
            }
            else {
                logger.info('Home Assistant has gone offline');
            }
        }
    });
    function changeAlarmStatus(code, partitionId) {
        return __awaiter(this, void 0, void 0, function* () {
            switch (code) {
                case 'DISARM':
                    return yield panel.disarmPart(partitionId);
                case 'ARM_HOME':
                case 'ARM_NIGHT':
                    return yield panel.armHome(partitionId);
                case 'ARM_AWAY':
                    return yield panel.armAway(partitionId);
            }
        });
    }
    function alarmPayload(partition) {
        if (partition.Alarm) {
            return 'triggered';
        }
        else if (!partition.Arm && !partition.HomeStay) {
            return 'disarmed';
        }
        else {
            if (partition.HomeStay) {
                return 'armed_home';
            }
            else {
                return 'armed_away';
            }
        }
    }
    function publishPartitionStateChanged(partition) {
        mqttClient.publish(`${config.mqtt_alarm_topic}/${partition.Id}/status`, alarmPayload(partition), { qos: 1, retain: true });
        logger.info(`[Panel => MQTT] Published alarm status ${alarmPayload(partition)} on partition ${partition.Id}`);
    }
    function publishZoneStateChange(zone, publishAttributes) {
        if (publishAttributes) {
            mqttClient.publish(`${config.mqtt_alarm_topic}/zone/${zone.Id}`, JSON.stringify({
                id: zone.Id,
                label: zone.Label,
                type: zone.type,
                typeLabel: zone.typeLabel,
                tech: zone.tech,
                techLabel: zone.techLabel,
                tamper: zone.Tamper,
            }), { qos: 1, retain: true });
        }
        let zoneStatus = zone.Open ? '1' : '0';
        mqttClient.publish(`${config.mqtt_alarm_topic}/zone/${zone.Id}/status`, zoneStatus, {
            qos: 1, retain: false,
        });
        logger.verbose(`[Panel => MQTT] Published zone status ${zoneStatus} on zone ${zone.Label}`);
    }
    function publishZoneBypassStateChange(zone) {
        mqttClient.publish(`${config.mqtt_alarm_topic}/zone/${zone.Id}-bypass/status`, zone.Bypass ? '1' : '0', {
            qos: 1, retain: false,
        });
        logger.verbose(`[Panel => MQTT] Published zone bypass status ${zone.Bypass} on zone ${zone.Label}`);
    }
    function activePartitions(partitions) {
        return partitions.values.filter(p => p.Exist);
    }
    function activeZones(zones) {
        return zones.values.filter(z => !z.NotUsed);
    }
    function publishOnline() {
        mqttClient.publish(`${config.mqtt_alarm_topic}/status`, 'online', {
            qos: 1, retain: true,
        });
        logger.verbose('[Panel => MQTT] Published alarm online');
    }
    function publishOffline() {
        if (mqttReady) {
            mqttClient.publish(`${config.mqtt_alarm_topic}/status`, 'offline', {
                qos: 1, retain: true,
            });
            logger.verbose('[Panel => MQTT] Published alarm offline');
        }
    }
    function getDeviceInfo() {
        return {
            manufacturer: 'Risco',
            model: `${panel.riscoComm.panelInfo.PanelModel}/${panel.riscoComm.panelInfo.PanelType}`,
            name: panel.riscoComm.panelInfo.PanelModel,
            sw_version: panel.riscoComm.panelInfo.PanelFW,
            identifiers: `risco-alarm-panel`,
        };
    }
    function publishHomeAssistantDiscoveryInfo() {
        var _a;
        for (const partition of activePartitions(panel.partitions)) {
            const payload = {
                name: partition.Label,
                object_id: `risco-alarm-panel-${partition.Id}`,
                state_topic: `${config.mqtt_alarm_topic}/${partition.Id}/status`,
                unique_id: `risco-alarm-panel-${partition.Id}`,
                availability: {
                    topic: `${config.mqtt_alarm_topic}/status`,
                },
                device: getDeviceInfo(),
                command_topic: `${config.mqtt_alarm_topic}/${partition.Id}/set`,
            };
            mqttClient.publish(`${config.ha_discovery_prefix_topic}/alarm_control_panel/${RISCO_NODE_ID}/${partition.Id}/config`, JSON.stringify(payload), {
                qos: 1, retain: true,
            });
            logger.info(`[Panel => MQTT][Discovery] Published alarm_control_panel to HA on partition ${partition.Id}`);
            logger.verbose(`[Panel => MQTT][Discovery] Alarm discovery payload\n${JSON.stringify(payload, null, 2)}`);
        }
        for (const zone of activeZones(panel.zones)) {
            // const partitionId = zone.Parts[0];
            const zoneConf = (0, lodash_1.cloneDeep)(config.zones.default);
            (0, merge_1.default)(zoneConf, (_a = config.zones) === null || _a === void 0 ? void 0 : _a[zone.Label]);
            const payload = {
                availability: {
                    topic: `${config.mqtt_alarm_topic}/status`,
                },
                unique_id: `risco-alarm-panel-zone-${zone.Id}`,
                payload_on: '1',
                payload_off: '0',
                device_class: zoneConf.device_class,
                device: getDeviceInfo(),
                qos: 1,
                state_topic: `${config.mqtt_alarm_topic}/zone/${zone.Id}/status`,
                json_attributes_topic: `${config.mqtt_alarm_topic}/zone/${zone.Id}`,
            };
            const bypassZonePayload = {
                availability: {
                    topic: `${config.mqtt_alarm_topic}/status`,
                },
                unique_id: `risco-alarm-panel-zone-${zone.Id}-bypass`,
                payload_on: '1',
                payload_off: '0',
                state_on: '1',
                state_off: '0',
                icon: 'mdi:toggle-switch-off',
                device: getDeviceInfo(),
                qos: 1,
                state_topic: `${config.mqtt_alarm_topic}/zone/${zone.Id}-bypass/status`,
                command_topic: `${config.mqtt_alarm_topic}/zone/${zone.Id}-bypass/set`,
            };
            if (zoneConf.off_delay) {
                payload.off_delay = zoneConf.off_delay; // If the service is stopped with any activated zone, it can remain forever on without this config
            }
            const zoneName = zoneConf.name || zone.Label;
            payload.name = zoneConf.name_prefix + zoneName;
            bypassZonePayload.name = zoneConf.name_prefix + zoneName + ' Bypass';
            let nodeIdSegment;
            if (config.ha_discovery_include_nodeId) {
                nodeIdSegment = `${zone.Label.replace(/ /g, '-')}/${zone.Id}`;
            }
            else {
                nodeIdSegment = `${zone.Id}`;
            }
            mqttClient.publish(`${config.ha_discovery_prefix_topic}/binary_sensor/${nodeIdSegment}/config`, JSON.stringify(payload), {
                qos: 1,
                retain: true,
            });
            mqttClient.publish(`${config.ha_discovery_prefix_topic}/switch/${nodeIdSegment}-bypass/config`, JSON.stringify(bypassZonePayload), {
                qos: 1,
                retain: true,
            });
            logger.info(`[Panel => MQTT][Discovery] Published binary_sensor to HA: Zone label = ${zone.Label}, HA name = ${payload.name}`);
            logger.info(`[Panel => MQTT][Discovery] Published switch to HA: Zone label = ${zone.Label}, HA name = ${bypassZonePayload.name}`);
            logger.verbose(`[Panel => MQTT][Discovery] Sensor discovery payload\n${JSON.stringify(payload, null, 2)}`);
            logger.verbose(`[Panel => MQTT][Discovery] Bypass switch discovery payload\n${JSON.stringify(bypassZonePayload, null, 2)}`);
        }
    }
    function panelOrMqttConnected() {
        if (!panelReady) {
            logger.info(`Panel is not connected, waiting`);
            return;
        }
        if (!mqttReady) {
            logger.info(`MQTT is not connected, waiting`);
            return;
        }
        logger.info(`Panel and MQTT communications are ready`);
        logger.info(`Publishing Home Assistant discovery info`);
        publishHomeAssistantDiscoveryInfo();
        publishOnline();
        logger.info(`Publishing initial partitions and zones state to Home assistant`);
        for (const partition of activePartitions(panel.partitions)) {
            publishPartitionStateChanged(partition);
        }
        for (const zone of activeZones(panel.zones)) {
            publishZoneStateChange(zone, true);
            publishZoneBypassStateChange(zone);
        }
        if (!listenerInstalled) {
            logger.info(`Subscribing to Home assistant commands topics`);
            for (const partition of activePartitions(panel.partitions)) {
                const partitionCommandsTopic = `${config.mqtt_alarm_topic}/${partition.Id}/set`;
                logger.info(`Subscribing to ${partitionCommandsTopic} topic`);
                mqttClient.subscribe(partitionCommandsTopic);
            }
            for (const zone of activeZones(panel.zones)) {
                const zoneBypassTopic = `${config.mqtt_alarm_topic}/zone/${zone.Id}-bypass/set`;
                logger.info(`Subscribing to ${zoneBypassTopic} topic`);
                mqttClient.subscribe(zoneBypassTopic);
            }
            logger.info(`Subscribing to panel partitions events`);
            panel.partitions.on('PStatusChanged', (Id, EventStr) => {
                if (['Armed', 'Disarmed', 'HomeStay', 'HomeDisarmed', 'Alarm', 'StandBy'].includes(EventStr)) {
                    publishPartitionStateChanged(panel.partitions.byId(Id));
                }
            });
            logger.info(`Subscribing to panel zones events`);
            panel.zones.on('ZStatusChanged', (Id, EventStr) => {
                if (['Closed', 'Open'].includes(EventStr)) {
                    publishZoneStateChange(panel.zones.byId(Id), false);
                }
                if (['Bypassed', 'UnBypassed'].includes(EventStr)) {
                    publishZoneBypassStateChange(panel.zones.byId(Id));
                }
            });
            logger.info(`Subscribing to Home Assistant online status`);
            mqttClient.subscribe(`${config.ha_discovery_prefix_topic}/status`, { qos: 0 }, function (error, granted) {
                if (error) {
                    logger.error(`Error subscribing to ${config.ha_discovery_prefix_topic}/status`);
                }
                else {
                    logger.info(`${granted[0].topic} was subscribed`);
                }
            });
            panel.riscoComm.on('Clock', publishOnline);
            listenerInstalled = true;
        }
        else {
            logger.info('Listeners already installed, skipping listeners registration');
        }
        logger.info(`Initialization completed`);
    }
}
exports.riscoMqttHomeAssistant = riscoMqttHomeAssistant;
//# sourceMappingURL=risco-mqtt-local.js.map
