cc_binary(
    name = "gwcheck",
    srcs = ["gwcheck.cc"],
    linkopts = ["-static-libstdc++", "-Wl,-z,max-page-size=16384"],
    deps = [
        "@litert//litert/cc:litert_common",
        "@litert//litert/cc:litert_compiled_model",
        "@litert//litert/cc:litert_environment",
        "@litert//litert/cc:litert_environment_options",
        "@litert//litert/cc:litert_model",
        "@litert//litert/cc:litert_tensor_buffer",
        "@litert//litert/cc:litert_options",
        "@litert//litert/cc/options:litert_google_tensor_options",
    ],
)
