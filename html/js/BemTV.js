var quickconnect = require('rtc-quickconnect');
var buffered = require('rtc-bufferedchannel');
var freeice = require('freeice');
var utils = require('./Utils.js');

BEMTV_ROOM_DISCOVER_URL = "http://server.bem.tv:9000/room"
BEMTV_SERVER = "http://server.bem.tv:8080"
ICE_SERVERS = freeice();
CHUNK_REQ = "req"
CHUNK_OFFER = "offer"
P2P_TIMEOUT = 1.5 // in seconds
MAX_CACHE_SIZE = 4;

var BemTV = function() {
  this._init();
}

BemTV.version = "1.0";

BemTV.prototype = {
  _init: function() {
    self = this;
    this.room = this.discoverMyRoom();
    this.setupPeerConnection();
    this.chunksCache = {};
    this.swarmSize = 0;
    this.bufferedChannel = undefined;
    this.requestTimeout = undefined;
  },

  setupPeerConnection: function() {
    this.connection = quickconnect(BEMTV_SERVER, {room: this.room, iceServers: ICE_SERVERS});
    this.dataChannel = this.connection.createDataChannel(this.room);
    this.dataChannel.on(this.room + ":open", this.onOpen);
    this.dataChannel.on("peer:connect", this.onConnect);
    this.dataChannel.on("peer:leave", this.onDisconnect);
  },

  discoverMyRoom: function() {
    var response = utils.request(BEMTV_ROOM_DISCOVER_URL);
    var room = response? JSON.parse(response)['room']: "bemtv";
    utils.updateRoomName(room);
    return room;
  },

  onOpen: function(dc, id) {
    console.log("Peer entered the room: " + id);
    self.bufferedChannel = buffered(dc);
    self.bufferedChannel.on('data', function(data) { self.onData(id, data); });
  },

  onData: function(id, data) {
    var parsedData = utils.parseData(data);
    var resource = parsedData['resource'];

    if (self.isReq(parsedData) && resource in self.chunksCache) {
      console.log("Sending chunk " + resource + " to " + id);
      var offerMessage = utils.createMessage(CHUNK_OFFER, resource, self.chunksCache[resource]);
      self.bufferedChannel.send(offerMessage);
      utils.updateBytesSentUsingP2P(self.chunksCache[resource].length);

    } else if (self.isOffer(parsedData) && resource == self.currentUrl) {
      clearTimeout(self.requestTimeout);
      self.sendToPlayer(parsedData['chunk']);
      utils.updateBytesRecvFromP2P(parsedData['chunk'].length);
      console.log("Chunk " + parsedData['resource'] + " received from p2p");

    } else if (self.isOffer(parsedData) && !(resource in self.chunksCache) && resource != self.currentUrl) {
      console.log(resource + " isn't the one that I'm looking for, but I'm going to put on my cache. :-)");
      self.chunksCache[resource] = parsedData['chunk'];

    } else {
      console.log("No action associated to: " + parsedData['action'] + " for " + resource);
    }
  },

  isReq: function(parsedData) {
    return parsedData['action'] == CHUNK_REQ;
  },

  isOffer: function(parsedData) {
    return parsedData['action'] == CHUNK_OFFER;
  },

  onDisconnect: function(id) {
    self.swarmSize -= 1;
    utils.updateSwarmSize(self.swarmSize);
  },

  onConnect: function(id) {
    self.swarmSize += 1;
    utils.updateSwarmSize(self.swarmSize);
  },

  requestResource: function(url) {
    if (url != this.currentUrl) {
      this.currentUrl = url;
      if (this.currentUrl in self.chunksCache) {
        console.log("Chunk is already on cache, getting from it");
        this.sendToPlayer(self.chunksCache[url]);
      }
      if (this.swarmSize > 0) {
        this.getFromP2P(url);
      } else {
        console.log("No peers available.");
        this.getFromCDN(url);
      }
    } else {
      console.log("Skipping double downloads!");
    }
  },

  getFromP2P: function(url) {
    console.log("Trying to get from swarm " + url);
    var reqMessage = utils.createMessage(CHUNK_REQ, url);
    this.bufferedChannel.send(reqMessage);
    this.requestTimeout = setTimeout(function() { self.getFromCDN(url); }, P2P_TIMEOUT * 1000);
  },

  getFromCDN: function(url) {
    console.log("Getting from CDN " + url);
    utils.request(url, this.readBytes, "arraybuffer");
  },

  readBytes: function(e) {
    var res = utils.base64ArrayBuffer(e.currentTarget.response);
    self.sendToPlayer(res);
    utils.updateBytesFromCDN(res.length);
  },

  sendToPlayer: function(data) {
    var bemtvPlayer = document.getElementById('BemTVplayer');
    self.chunksCache[self.currentUrl] = data;
    self.currentUrl = undefined;
    bemtvPlayer.resourceLoaded(data);
    self.checkCacheSize();
  },

  checkCacheSize: function() {
    var cacheKeys = Object.keys(self.chunksCache);
    if (cacheKeys.length > MAX_CACHE_SIZE) {
      var key = self.chunksCache;
      console.log("Removing from cache: " + cacheKeys[0]);
      delete self.chunksCache[cacheKeys[0]];
    }
  },
}

module.exports = BemTV;
