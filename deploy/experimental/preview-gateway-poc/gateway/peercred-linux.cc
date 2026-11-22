#include <node_api.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>

static napi_value PeerUid(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value argv[1];
  if (napi_get_cb_info(env, info, &argc, argv, nullptr, nullptr) != napi_ok || argc != 1) return nullptr;
  int32_t fd = -1;
  if (napi_get_value_int32(env, argv[0], &fd) != napi_ok || fd < 0) return nullptr;
  struct ucred credentials;
  socklen_t length = sizeof(credentials);
  if (getsockopt(fd, SOL_SOCKET, SO_PEERCRED, &credentials, &length) != 0 || length != sizeof(credentials)) return nullptr;
  napi_value result;
  if (napi_create_uint32(env, credentials.uid, &result) != napi_ok) return nullptr;
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_value function;
  if (napi_create_function(env, "peerUid", NAPI_AUTO_LENGTH, PeerUid, nullptr, &function) != napi_ok) return nullptr;
  if (napi_set_named_property(env, exports, "peerUid", function) != napi_ok) return nullptr;
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
