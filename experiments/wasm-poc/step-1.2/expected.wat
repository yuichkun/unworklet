(module
 (type $0 (func (param i32) (result i32)))
 (export "passthrough" (func $passthrough))
 (func $passthrough (param $0 i32) (result i32)
  (local.get $0)
 )
)
