use std::sync::atomic::{AtomicBool,Ordering};
static ENGLISH:AtomicBool=AtomicBool::new(false);
pub fn set_language(language:&str){ENGLISH.store(language=="en",Ordering::Relaxed);}
pub fn english()->bool{ENGLISH.load(Ordering::Relaxed)}
// 只用于应用提供的系统对话框文案，不翻译文件名和文档内容。
pub fn text(source:&str)->String{
    if !english(){return source.into();}
    let dictionary:std::collections::BTreeMap<String,String>=serde_json::from_str(include_str!("../../src/i18n/zh-en.json")).unwrap_or_default();
    if let Some(value)=dictionary.get(source){return value.clone();}
    let mut entries:Vec<_>=dictionary.iter().collect();entries.sort_by_key(|(key,_)|std::cmp::Reverse(key.len()));
    let mut value=source.to_owned();for(key,translation)in entries{value=value.replace(key,translation);}value
}
