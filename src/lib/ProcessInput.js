//     NoFlo - Flow-Based Programming for JavaScript
//     (c) 2013-2020 Flowhub UG
//     (c) 2011-2012 Henri Bergius, Nemein
//     NoFlo may be freely distributed under the MIT license
/* eslint-disable no-underscore-dangle */
const debug = require('debug')('noflo:component');

module.exports = class ProcessInput {
  constructor(ports, context) {
    this.ports = ports;
    this.context = context;
    this.nodeInstance = this.context.nodeInstance;
    this.ip = this.context.ip;
    this.port = this.context.port;
    this.result = this.context.result;
    this.scope = this.context.scope;
  }

  // When preconditions are met, set component state to `activated`
  activate() {
    if (this.context.activated) { return; }
    if (this.nodeInstance.isOrdered()) {
      // We're handling packets in order. Set the result as non-resolved
      // so that it can be send when the order comes up
      this.result.__resolved = false;
    }
    this.nodeInstance.activate(this.context);
    if (this.port.isAddressable()) {
      debug(`${this.nodeInstance.nodeId} packet on '${this.port.name}[${this.ip.index}]' caused activation ${this.nodeInstance.load}: ${this.ip.type}`);
    } else {
      debug(`${this.nodeInstance.nodeId} packet on '${this.port.name}' caused activation ${this.nodeInstance.load}: ${this.ip.type}`);
    }
  }

  // ## Connection listing
  // This allows components to check which input ports are attached. This is
  // useful mainly for addressable ports
  attached(...params) {
    let args = params;
    if (!args.length) { args = ['in']; }
    const res = [];
    args.forEach((port) => {
      if (!this.ports[port]) {
        throw new Error(`Node ${this.nodeInstance.nodeId} has no port '${port}'`);
      }
      res.push(this.ports[port].listAttached());
    });
    if (args.length === 1) { return res.pop(); }
    return res;
  }

  // ## Input preconditions
  // When the processing function is called, it can check if input buffers
  // contain the packets needed for the process to fire.
  // This precondition handling is done via the `has` and `hasStream` methods.

  // Returns true if a port (or ports joined by logical AND) has a new IP
  // Passing a validation callback as a last argument allows more selective
  // checking of packets.
  has(...params) {
    let args = params;
    let validate;
    if (!args.length) { args = ['in']; }
    if (typeof args[args.length - 1] === 'function') {
      validate = args.pop();
    } else {
      validate = () => true;
    }
    for (let i = 0; i < args.length; i += 1) {
      const port = args[i];
      if (Array.isArray(port)) {
        if (!this.ports[port[0]]) {
          throw new Error(`Node ${this.nodeInstance.nodeId} has no port '${port[0]}'`);
        }
        if (!this.ports[port[0]].isAddressable()) {
          throw new Error(`Non-addressable ports, access must be with string ${port[0]}`);
        }
        if (!this.ports[port[0]].has(this.scope, port[1], validate)) { return false; }
      } else {
        if (!this.ports[port]) {
          throw new Error(`Node ${this.nodeInstance.nodeId} has no port '${port}'`);
        }
        if (this.ports[port].isAddressable()) {
          throw new Error(`For addressable ports, access must be with array [${port}, idx]`);
        }
        if (!this.ports[port].has(this.scope, validate)) { return false; }
      }
    }
    return true;
  }

  // Returns true if the ports contain data packets
  hasData(...params) {
    let args = params;
    if (!args.length) { args = ['in']; }
    args.push((ip) => ip.type === 'data');
    return this.has(...args);
  }

  // Returns true if a port has a complete stream in its input buffer.
  hasStream(...params) {
    let args = params;
    let validateStream;
    if (!args.length) { args = ['in']; }

    if (typeof args[args.length - 1] === 'function') {
      validateStream = args.pop();
    } else {
      validateStream = () => true;
    }

    for (let i = 0; i < args.length; i += 1) {
      const port = args[i];
      const portBrackets = [];
      let hasData = false;
      const validate = (ip) => {
        if (ip.type === 'openBracket') {
          portBrackets.push(ip.data);
          return false;
        }
        if (ip.type === 'data') {
          // Run the stream validation callback
          hasData = validateStream(ip, portBrackets);
          // Data IP on its own is a valid stream
          if (!portBrackets.length) { return hasData; }
          // Otherwise we need to check for complete stream
          return false;
        }
        if (ip.type === 'closeBracket') {
          portBrackets.pop();
          if (portBrackets.length) { return false; }
          if (!hasData) { return false; }
          return true;
        }
        return false;
      };
      if (!this.has(port, validate)) { return false; }
    }
    return true;
  }

  // ## Input processing
  //
  // Once preconditions have been met, the processing function can read from
  // the input buffers. Reading packets sets the component as "activated".
  //
  // Fetches IP object(s) for port(s)
  get(...params) {
    this.activate();
    let args = params;
    if (!args.length) { args = ['in']; }
    const res = [];
    for (let i = 0; i < args.length; i += 1) {
      const port = args[i];
      let idx;
      let ip;
      let portname;
      if (Array.isArray(port)) {
        [portname, idx] = Array.from(port);
        if (!this.ports[portname].isAddressable()) {
          throw new Error('Non-addressable ports, access must be with string portname');
        }
      } else {
        portname = port;
        if (this.ports[portname].isAddressable()) {
          throw new Error('For addressable ports, access must be with array [portname, idx]');
        }
      }
      if (this.nodeInstance.isForwardingInport(portname)) {
        ip = this.__getForForwarding(portname, idx);
        res.push(ip);
      } else {
        ip = this.ports[portname].get(this.scope, idx);
        res.push(ip);
      }
    }

    if (args.length === 1) { return res[0]; } return res;
  }

  __getForForwarding(port, idx) {
    const prefix = [];
    let dataIp = null;
    // Read IPs until we hit data
    let ok = true;
    while (ok) {
      // Read next packet
      const ip = this.ports[port].get(this.scope, idx);
      // Stop at the end of the buffer
      if (!ip) { break; }
      if (ip.type === 'data') {
        // Hit the data IP, stop here
        dataIp = ip;
        ok = false;
        break;
      }
      // Keep track of bracket closings and openings before
      prefix.push(ip);
    }

    // Forwarding brackets that came before data packet need to manipulate context
    // and be added to result so they can be forwarded correctly to ports that
    // need them
    for (let i = 0; i < prefix.length; i += 1) {
      const ip = prefix[i];
      if (ip.type === 'closeBracket') {
        // Bracket closings before data should remove bracket context
        if (!this.result.__bracketClosingBefore) { this.result.__bracketClosingBefore = []; }
        const context = this.nodeInstance.getBracketContext('in', port, this.scope, idx).pop();
        context.closeIp = ip;
        this.result.__bracketClosingBefore.push(context);
      } else if (ip.type === 'openBracket') {
        // Bracket openings need to go to bracket context
        this.nodeInstance.getBracketContext('in', port, this.scope, idx).push({
          ip,
          ports: [],
          source: port,
        });
      }
    }

    // Add current bracket context to the result so that when we send
    // to ports we can also add the surrounding brackets
    if (!this.result.__bracketContext) { this.result.__bracketContext = {}; }
    this.result.__bracketContext[port] = this.nodeInstance.getBracketContext('in', port, this.scope, idx).slice(0);
    // Bracket closings that were in buffer after the data packet need to
    // be added to result for done() to read them from
    return dataIp;
  }

  // Fetches `data` property of IP object(s) for given port(s)
  getData(...params) {
    let args = params;
    if (!args.length) { args = ['in']; }

    const datas = [];
    args.forEach((port) => {
      let packet = this.get(port);
      if (packet == null) {
        // we add the null packet to the array so when getting
        // multiple ports, if one is null we still return it
        // so the indexes are correct.
        datas.push(packet);
        return;
      }

      while (packet.type !== 'data') {
        packet = this.get(port);
        if (!packet) { break; }
      }

      datas.push(packet.data);
    });

    if (args.length === 1) { return datas.pop(); }
    return datas;
  }

  // Fetches a complete data stream from the buffer.
  getStream(...params) {
    let args = params;
    if (!args.length) { args = ['in']; }
    const datas = [];
    for (let i = 0; i < args.length; i += 1) {
      const port = args[i];
      const portBrackets = [];
      let portPackets = [];
      let hasData = false;
      let ip = this.get(port);
      if (!ip) { datas.push(undefined); }
      while (ip) {
        if (ip.type === 'openBracket') {
          if (!portBrackets.length) {
            // First openBracket in stream, drop previous
            portPackets = [];
            hasData = false;
          }
          portBrackets.push(ip.data);
          portPackets.push(ip);
        }
        if (ip.type === 'data') {
          portPackets.push(ip);
          hasData = true;
          // Unbracketed data packet is a valid stream
          if (!portBrackets.length) { break; }
        }
        if (ip.type === 'closeBracket') {
          portPackets.push(ip);
          portBrackets.pop();
          if (hasData && !portBrackets.length) {
            // Last close bracket finishes stream if there was data inside
            break;
          }
        }
        ip = this.get(port);
      }
      datas.push(portPackets);
    }

    if (args.length === 1) { return datas.pop(); }
    return datas;
  }
};
