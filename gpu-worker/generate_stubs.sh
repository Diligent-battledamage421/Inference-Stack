#!/bin/bash
# Generate Python gRPC stubs from the proto file.
# Run this after installing grpcio-tools: pip install grpcio-tools

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

mkdir -p generated

python3 -m grpc_tools.protoc \
  -I./proto \
  --python_out=./generated \
  --grpc_python_out=./generated \
  proto/inference_worker.proto

# Fix the import in the generated grpc file.
# grpc_tools generates `import inference_worker_pb2` (bare),
# but we need `from generated import ...` or a relative import.
# Use relative import so it works inside the generated/ package.
sed -i.bak 's/^import inference_worker_pb2/from . import inference_worker_pb2/' generated/inference_worker_pb2_grpc.py
rm -f generated/inference_worker_pb2_grpc.py.bak

# Create __init__.py so generated/ is a package
touch generated/__init__.py

echo "Stubs generated in generated/"
