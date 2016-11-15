# hyalinehash

Redis without callbacks. Automatically syncs a Node.js object with a Redis hash (and the other way around too).

## Name

Hyaline = "something glassy or transparent"
Hash = The hash data struture in Redis

Original, right?

## Usage
```
var
  redis       = require('redis');
  hyalineHash = require('hyalinehash'),
  client      = redis.createClient(),
  subClient   = redis.createClient(),
  yourObj     = {};

var yourObj = hyalineHash(client, subClient, 'your-obj',true);
yourObj.pull();
```

## TODO

* Better documentation
* tests
