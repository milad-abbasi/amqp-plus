const { EventEmitter } = require('events');
const amqp = require('amqp-connection-manager');

class AmqpPlus extends EventEmitter {
  constructor(config) {
    super();
    if (AmqpPlus.instance) {
      return AmqpPlus.instance;
    }
    AmqpPlus.instance = this;

    this._validateConfig(config);

    this._config = config;
    this._connect();
  }

  _validateConfig({ urls, exchanges = [], queues = [], bindings = [] }) {
    if (!urls || (Array.isArray(urls) && urls.length === 0)) {
      throw new Error('Atleast one url is needed');
    }

    if (
      !Array.isArray(exchanges) ||
      !Array.isArray(queues) ||
      !Array.isArray(bindings)
    ) {
      throw new Error('Exchanges, queues or bindings must be an array');
    }

    this._configuredExchanges = exchanges.reduce((acc, exchange) => {
      acc[exchange.name] = exchange;
      return acc;
    }, {});
    this._configuredQueues = queues.reduce((acc, queue) => {
      acc[queue.name] = queue;
      return acc;
    }, {});

    bindings.forEach((binding) => {
      if (!binding.exchange || !binding.queue) {
        throw new Error('Binding must have an exchange and a queue');
      }

      if (!this._configuredExchanges[binding.exchange]) {
        throw new Error(
          `Exchange "${binding.exchange}" must be configured before binding`
        );
      }

      if (!this._configuredQueues[binding.queue]) {
        throw new Error(
          `Queue "${binding.queue}" must be configured before binding`
        );
      }

      if (Array.isArray(binding.keys) && binding.keys.length === 0) {
        throw new Error('Binding keys can NOT be an empty array');
      }

      if (
        this._configuredExchanges[binding.exchange].type !== 'fanout' &&
        !('keys' in binding)
      ) {
        throw new Error(
          `Binding of queue "${binding.queue}" to exchange "${binding.exchange}" must have keys`
        );
      }
    });
  }

  _connect() {
    if (this._connection && this._connection.isConnected()) {
      return;
    }

    const serverUrls = Array.isArray(this._config.urls)
      ? this._config.urls
      : [this._config.urls];
    this._connection = amqp.connect(serverUrls);
    this._emitConnectionEvents();

    const { exchanges, queues, bindings } = this._config;
    this._confirmChannel = this._connection.createChannel({
      setup: (channel) => {
        const exchangesSetup = exchanges.map((exchange) => {
          if (!exchange.name || !exchange.type) {
            throw new Error('Exchange must have name and type');
          }

          return channel.assertExchange(exchange.name, exchange.type, {
            durable: exchange.durable || true,
            autoDelete: exchange.autoDelete || false
          });
        });

        const queuesSetup = queues.map((queue) => {
          if (!queue.name) {
            throw new Error('Queue must have a name');
          }

          return channel.assertQueue(queue.name, {
            durable: queue.durable || true,
            autoDelete: queue.autoDelete || false,
            exclusive: queue.exclusive || false
          });
        });

        const bindingsSetup = [];
        bindings.forEach((binding) => {
          const bindingKeys = Array.isArray(binding.keys)
            ? binding.keys
            : [binding.keys];

          bindingKeys.forEach((bindingKey) => {
            bindingsSetup.push(
              channel.bindQueue(binding.queue, binding.exchange, bindingKey)
            );
          });
        });

        return Promise.all([
          ...exchangesSetup,
          ...queuesSetup,
          ...bindingsSetup
        ]);
      }
    });
    this._emitChannelEvents();
  }

  _emitConnectionEvents() {
    this._connection.on('connect', ({ connection, url }) =>
      this.emit('connect', { connection, url })
    );
    this._connection.on('disconnect', (err) => this.emit('disconnect', err));
  }

  _emitChannelEvents() {
    this._confirmChannel.on('connect', () => this.emit('channel:connect'));
    this._confirmChannel.on('error', (err, name) =>
      this.emit('channel:error', err, name)
    );
    this._confirmChannel.on('close', () => this.emit('channel:close'));
  }

  waitForConnect() {
    return this._confirmChannel.waitForConnect();
  }

  sendToQueue(queue, content, options) {
    return this.publish('', queue, content, options);
  }

  bulkSendToQueue(queues, contents, options) {
    return this.bulkPublish('', queues, contents, options);
  }

  publish(exchange, routingKey, content, options = {}) {
    let msg = content;
    const defaultOptions = { ...options };
    defaultOptions.persistent = options.persistent || true;

    if (typeof content === 'string') {
      msg = Buffer.from(content);
      defaultOptions.contentType = 'text/plain';
    }
    if (content.constructor === Object || content.constructor === Array) {
      msg = Buffer.from(JSON.stringify(content));
      defaultOptions.contentType = 'application/json';
    }

    return this._confirmChannel.publish(
      exchange,
      routingKey,
      msg,
      defaultOptions
    );
  }

  bulkPublish(exchange, routingKeys, contents, options) {
    if (!Array.isArray(contents)) {
      throw new Error('Contents must be an array');
    }

    if (Array.isArray(routingKeys) && contents.length !== routingKeys.length) {
      throw new Error('Not enough routing keys');
    }

    let routingKey;
    if (typeof routingKeys === 'string') {
      routingKey = routingKeys;
    }

    return Promise.all(
      contents.map((content, i) => {
        return this.publish(
          exchange,
          routingKey || routingKeys[i],
          content,
          options
        );
      })
    );
  }

  subscribe(queueName, consumer, options) {
    if (!this._configuredQueues[queueName]) {
      throw new Error(
        `Queue "${queueName}" must be configured before subscribing`
      );
    }

    return this._confirmChannel.addSetup((channel) => {
      return channel.consume(
        queueName,
        this._consumeWrapper(consumer),
        options
      );
    });
  }

  _consumeWrapper(consumer) {
    return (msg) => {
      const enhancedMessage = msg;
      enhancedMessage.ack = () => this._confirmChannel.ack(msg);
      enhancedMessage.nack = () => this._confirmChannel.nack(msg);
      enhancedMessage.reject = () =>
        this._confirmChannel.nack(msg, false, false);

      if (msg.properties.contentType === 'application/json') {
        enhancedMessage.content = JSON.parse(msg.content.toString());
      }

      if (msg.properties.contentType === 'text/plain') {
        enhancedMessage.content = msg.content.toString();
      }

      return consumer(enhancedMessage);
    };
  }

  async close() {
    await this._confirmChannel.close();
    await this._connection.close();
  }
}

module.exports = AmqpPlus;
